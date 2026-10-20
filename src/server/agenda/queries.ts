import { desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner, type Role } from "@/lib/roles";
import { partsInTz } from "@/lib/time/slots";
import type { BookingReminderDto } from "@/lib/reminders";
import { remindersForBookings } from "@/server/agenda/reminders";
import { getSettings } from "@/server/agenda/settings";

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

export async function listBookings(
  organizationId: string,
  opts: {
    viewer: BookingViewer;
    /** Vendedor: id ⇒ sus citas; null ⇒ solo las sin asignar; ausente ⇒ todas. */
    sellerId?: string | null;
    typeId?: string;
  }
): Promise<BookingListItem[]> {
  const db = getDb();
  const settings = await getSettings(organizationId);

  const sellerFilter =
    opts.sellerId === undefined
      ? undefined
      : opts.sellerId === null
        ? isNull(schema.booking.assignedUserId)
        : eq(schema.booking.assignedUserId, opts.sellerId);

  const rows = await db
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
          : undefined
      )
    )
    .orderBy(desc(schema.booking.scheduledAt))
    .limit(200);

  const reminders = await remindersForBookings(
    organizationId,
    rows.map((r) => r.booking.id),
    new Date()
  );

  return rows.map((r) => {
    const scheduledAtUtc = r.booking.scheduledAt.toISOString();
    const parts = partsInTz(scheduledAtUtc, settings.timezone);
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
