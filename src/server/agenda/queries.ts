import { asc, desc, eq, gte, isNull, lt, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner, type Role } from "@/lib/roles";
import type { DateRange } from "@/lib/time/calendar";
import { addDaysISO, partsInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import type { BookingReminderDto } from "@/lib/reminders";
import { getBusyIntervals } from "@/server/agenda/availability";
import {
  computeOverlaps,
  pickOverlaps,
  type OverlapMap,
} from "@/server/agenda/overlaps";
import { remindersForBookings } from "@/server/agenda/reminders";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";

/** 015 — Listado de citas para la UI, con la hora en la zona del negocio. */

export type BookingListItem = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  date: string;
  time: string;
  weekday: string;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  /** Con qué conector nació la entrega de esta cita. */
  connector: string | null;
  meetingLink: string | null;
  /** El proveedor falló al crear la reunión: se puede reintentar. */
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
  /**
   * 10 — Recordatorios de la hora VIGENTE (aditivo). Vacío en bloqueos, en
   * citas de prueba y con los recordatorios apagados.
   */
  reminders: BookingReminderDto[];
  /** 023 — Tipo de cita; null en bloqueos y en citas de la 015. */
  type: { id: string; name: string } | null;
  /** 023 — Vendedor; null ⇒ "Sin asignar". */
  assignedUser: { id: string; name: string } | null;
  /** 023 — Quien la creó (null si la agendó la IA o es de la 015). */
  createdByUserId: string | null;
  /** 023 — ¿Ocupa el tipo en exclusiva? (copia del tipo al crear). */
  exclusive: boolean;
};

/** 023 — Quién mira la agenda: decide qué citas ve. */
export type BookingViewer = { userId: string; role: Role };

/**
 * 023 — Visibilidad (A3, decisión 9): el Propietario ve todo; el Vendedor ve
 * las asignadas a él, las que él creó y las sin asignar (incluye bloqueos).
 * PURA: la usan las rutas para responder 404 a lo que no se ve.
 */
export function canViewBooking(
  row: { assignedUserId: string | null; createdByUserId: string | null },
  viewer: BookingViewer
): boolean {
  if (isOwner(viewer)) return true;
  return (
    row.assignedUserId === null ||
    row.assignedUserId === viewer.userId ||
    row.createdByUserId === viewer.userId
  );
}

/** La misma regla, en SQL. undefined ⇒ sin filtro (Propietario). */
function visibilityWhere(viewer: BookingViewer): SQL | undefined {
  if (isOwner(viewer)) return undefined;
  return or(
    isNull(schema.booking.assignedUserId),
    eq(schema.booking.assignedUserId, viewer.userId),
    eq(schema.booking.createdByUserId, viewer.userId)
  );
}

/**
 * 023 — La cita si el usuario la puede ver; null si no existe, es de otra
 * organización o no le toca (las rutas responden 404 en los tres casos).
 */
export async function getVisibleBooking(
  organizationId: string,
  bookingId: string,
  viewer: BookingViewer
): Promise<typeof schema.booking.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row || !canViewBooking(row, viewer)) return null;
  return row;
}

/** Filtros de la pantalla Citas (los mismos con o sin rango). */
export type BookingListFilters = {
  viewer: BookingViewer;
  /** Vendedor: id ⇒ sus citas; null ⇒ solo las sin asignar; ausente ⇒ todas. */
  sellerId?: string | null;
  typeId?: string;
};

/** Tope del listado sin rango: el de siempre (lo leen los guiones E2E). */
export const LIST_LIMIT = 200;

/**
 * 028 (de upstream 215) — Tope de seguridad de una consulta por rango. No es
 * un límite del producto (92 días de un negocio con 30 citas diarias son
 * 2 760): es el seguro contra una respuesta de megas. Si se alcanza, la
 * respuesta lo dice (`truncated`) en vez de esconder citas.
 */
export const RANGE_LIMIT = 3000;

/**
 * Cuánto mira hacia atrás la consulta por rango. La API acepta bloqueos de
 * hasta 600 minutos: uno que empezó a las 20:00 del día anterior al rango
 * sigue ocupando su madrugada y la rejilla lo tiene que pintar.
 */
export const RANGE_LOOKBACK_MS = 24 * 3_600_000;

type BookingRowWithJoins = {
  booking: typeof schema.booking.$inferSelect;
  contactId: string | null;
  contactName: string | null;
  typeId: string | null;
  typeName: string | null;
  sellerId: string | null;
  sellerName: string | null;
};

/**
 * Lo común a la Lista y al calendario: mismas columnas, misma visibilidad y
 * mismos filtros. Cada llamador decide el corte (`extra`), el orden y el tope.
 */
async function queryBookings(
  organizationId: string,
  opts: BookingListFilters & {
    extra?: SQL[];
    order: "asc" | "desc";
    limit: number;
  }
): Promise<BookingRowWithJoins[]> {
  const db = getDb();

  const sellerFilter =
    opts.sellerId === undefined
      ? undefined
      : opts.sellerId === null
        ? isNull(schema.booking.assignedUserId)
        : eq(schema.booking.assignedUserId, opts.sellerId);

  return db
    .select({
      booking: schema.booking,
      contactId: schema.contact.id,
      contactName: schema.contact.name,
      typeId: schema.appointmentType.id,
      typeName: schema.appointmentType.name,
      sellerId: schema.user.id,
      sellerName: schema.user.name,
    })
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
    .leftJoin(
      schema.appointmentType,
      eq(schema.booking.appointmentTypeId, schema.appointmentType.id)
    )
    .leftJoin(schema.user, eq(schema.booking.assignedUserId, schema.user.id))
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        visibilityWhere(opts.viewer),
        sellerFilter,
        opts.typeId
          ? eq(schema.booking.appointmentTypeId, opts.typeId)
          : undefined,
        ...(opts.extra ?? [])
      )
    )
    .orderBy(
      opts.order === "asc"
        ? asc(schema.booking.scheduledAt)
        : desc(schema.booking.scheduledAt)
    )
    .limit(opts.limit);
}

/** Filas → DTO de la UI, con recordatorios y la hora en la zona del negocio. */
async function toListItems(
  organizationId: string,
  rows: readonly BookingRowWithJoins[],
  timezone: string
): Promise<BookingListItem[]> {
  const reminders = await remindersForBookings(
    organizationId,
    rows.map((r) => r.booking.id),
    new Date()
  );

  return rows.map((r) => {
    const scheduledAtUtc = r.booking.scheduledAt.toISOString();
    const parts = partsInTz(scheduledAtUtc, timezone);
    return {
      id: r.booking.id,
      kind: r.booking.kind,
      status: r.booking.status,
      source: r.booking.source,
      scheduledAtUtc,
      durationMinutes: r.booking.durationMinutes,
      date: parts.date,
      time: parts.time,
      weekday: parts.weekday,
      contact: r.contactId
        ? { id: r.contactId, name: r.contactName ?? "" }
        : null,
      conversationId: r.booking.conversationId,
      connector: r.booking.connector,
      meetingLink: r.booking.meetingLink,
      linkPending: r.booking.linkPending,
      isTest: r.booking.isTest,
      notes: r.booking.notes,
      reminders: reminders.get(r.booking.id) ?? [],
      type: r.typeId ? { id: r.typeId, name: r.typeName ?? "" } : null,
      assignedUser: r.sellerId
        ? { id: r.sellerId, name: r.sellerName ?? "" }
        : null,
      createdByUserId: r.booking.createdByUserId,
      exclusive: r.booking.exclusive,
    };
  });
}

/** Las últimas 200 citas visibles: la Lista de siempre (sin rango). */
export async function listBookings(
  organizationId: string,
  opts: BookingListFilters
): Promise<BookingListItem[]> {
  const settings = await getSettings(organizationId);
  const rows = await queryBookings(organizationId, {
    ...opts,
    order: "desc",
    limit: LIST_LIMIT,
  });
  return toListItems(organizationId, rows, settings.timezone);
}

/**
 * Límites UTC de un rango de días del negocio: de la medianoche de `from` a
 * la medianoche que sigue a `to` (semiabierto).
 */
export function rangeBoundsUtc(
  range: DateRange,
  timezone: string
): { start: Date; end: Date } {
  // Fechas ya validadas (`parseRangeQuery`): la conversión no puede fallar.
  const start = zonedWallClockToUtc(range.from, "00:00", timezone)!;
  const end = zonedWallClockToUtc(addDaysISO(range.to, 1), "00:00", timezone)!;
  return { start, end };
}

/**
 * 028 (de upstream 215) — Las citas visibles que TOCAN un rango de días en la
 * zona del negocio, en orden ascendente, con los mismos filtros, visibilidad y
 * recordatorios que la Lista.
 *
 * `from`/`to` son fechas de calendario inclusivas; el corte es la medianoche
 * del NEGOCIO (con cortes en UTC, lo de después de las 18:00 en México caería
 * en la columna del día siguiente). Se mira 24 h hacia atrás y se queda solo
 * lo que sigue ocupando el rango.
 */
export async function listBookingsInRange(
  organizationId: string,
  range: DateRange,
  opts: BookingListFilters & { settings?: CalendarSettings }
): Promise<{ bookings: BookingListItem[]; truncated: boolean }> {
  const settings = opts.settings ?? (await getSettings(organizationId));
  const { start, end } = rangeBoundsUtc(range, settings.timezone);

  const rows = await queryBookings(organizationId, {
    viewer: opts.viewer,
    sellerId: opts.sellerId,
    typeId: opts.typeId,
    extra: [
      gte(
        schema.booking.scheduledAt,
        new Date(start.getTime() - RANGE_LOOKBACK_MS)
      ),
      lt(schema.booking.scheduledAt, end),
    ],
    order: "asc",
    limit: RANGE_LIMIT,
  });

  // De lo que empezó antes del rango, solo lo que sigue ocupándolo.
  const inRange = rows.filter(
    (r) =>
      r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000 >
      start.getTime()
  );
  return {
    bookings: await toListItems(organizationId, inRange, settings.timezone),
    truncated: rows.length === RANGE_LIMIT,
  };
}

/**
 * 028 (A4) — Traslapes de las citas que el viewer ve, calculados sobre TODA
 * la organización (antes de la visibilidad: la cita de otro vendedor que el
 * Vendedor no ve sigue traslapando la suya). `getBusyIntervals` ya deja solo
 * lo activo (agendada/realizada) y fuera las de prueba; la ventana mira 24 h
 * antes y después del rango para no perder lo que cruza sus bordes.
 */
export async function bookingOverlaps(
  organizationId: string,
  window: { start: Date; end: Date },
  visibleIds: readonly string[]
): Promise<OverlapMap> {
  if (visibleIds.length === 0) return {};
  const busy = await getBusyIntervals(organizationId, {
    fromUtc: new Date(window.start.getTime() - RANGE_LOOKBACK_MS),
    toUtc: new Date(window.end.getTime() + RANGE_LOOKBACK_MS),
  });
  return pickOverlaps(computeOverlaps(busy), visibleIds);
}
