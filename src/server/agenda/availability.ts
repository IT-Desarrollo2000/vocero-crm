import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  eachDateInRange,
  expandWorkingDayToUtc,
  labelInTz,
  overlaps,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  classify,
  STRICT,
  type BusyItem,
  type Classification,
  type ConflictContext,
} from "@/server/agenda/conflicts";
import type { AgendaDb } from "@/server/agenda/db";

/**
 * 015 — Motor de disponibilidad:
 *   horario semanal del negocio − citas activas − bloqueos manuales.
 *
 * 023 — Ya no es "libre u ocupado": cada hueco se clasifica contra lo ocupado
 * con el motor de choques (`conflicts.ts`). Lo hard se descarta; lo soft viaja
 * como `conflicts` para que un humano decida (en `strict` siempre vacío). La
 * rejilla arranca cada `slotMinutes + buffer` y cada hueco dura lo que dura el
 * TIPO de cita.
 *
 * Limitación v1 documentada (Constitución VII): NO lee calendarios externos.
 * Es una decisión, no un olvido: meter al proveedor en este camino acoplaría su
 * latencia y sus caídas a la pantalla que más se usa. Los compromisos de fuera
 * se reflejan con bloqueos manuales.
 */

export type AvailableSlot = SlotUtc & { label: string };

/** 023 — Un hueco ofrecible y las citas compatibles que ya lo ocupan. */
export type SlotWithConflicts = AvailableSlot & { conflicts: BusyItem[] };

/** Estados que ocupan agenda de verdad. Canceladas y no-show liberan. */
const OCCUPYING = ["agendada", "realizada"] as const;

/**
 * PURA: expande el horario semanal a slots candidatos en UTC. Sin BD, sin
 * reloj — se testea sola (tests/unit/availability.test.ts).
 *
 * 023 — `durationMinutes` (opcional) es el largo de cada hueco (la duración del
 * tipo); la rejilla sigue avanzando `slotMinutes + buffer`. Sin él, idéntico a
 * la 015.
 */
export function buildCandidateSlots(
  settings: CalendarSettings,
  fromISO: string,
  toISO: string,
  durationMinutes?: number
): SlotUtc[] {
  const tz = settings.timezone;
  const step = settings.slotMinutes + Math.max(0, settings.bufferMinutes);
  const length = durationMinutes ?? settings.slotMinutes;
  const candidates: SlotUtc[] = [];
  for (const date of eachDateInRange(fromISO, toISO)) {
    const weekday = weekdayKeyOf(date, tz);
    if (!weekday) continue;
    const intervals = settings.weeklyHours[weekday] ?? [];
    if (intervals.length === 0) continue; // día cerrado
    candidates.push(
      ...expandWorkingDayToUtc(
        date,
        intervals,
        tz,
        length,
        settings.bufferMinutes,
        step
      )
    );
  }
  return candidates;
}

/**
 * PURA: descarta lo que ya pasó (con aviso mínimo) y lo que se solapa con algo
 * ocupado, ordena y etiqueta. (015; se conserva para quien solo necesita
 * "libre u ocupado".)
 */
export function filterFreeSlots(
  candidates: SlotUtc[],
  busy: SlotUtc[],
  opts: { now: Date; minNoticeHours: number; timezone: string }
): AvailableSlot[] {
  const minStartMs = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  return candidates
    .filter((c) => Date.parse(c.startUtc) >= minStartMs)
    .filter(
      (c) =>
        !busy.some((b) => overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc))
    )
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
    .map((c) => ({ ...c, label: labelInTz(c.startUtc, opts.timezone) }));
}

/**
 * 023 — PURA: como `filterFreeSlots`, pero clasificando contra lo ocupado. Lo
 * hard se descarta; lo soft viaja en `conflicts`.
 */
export function classifySlots(
  candidates: SlotUtc[],
  busy: readonly BusyItem[],
  opts: {
    now: Date;
    minNoticeHours: number;
    timezone: string;
    ctx: ConflictContext;
    bufferMinutes: number;
  }
): SlotWithConflicts[] {
  const minStartMs = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  const out: SlotWithConflicts[] = [];
  for (const c of candidates) {
    if (Date.parse(c.startUtc) < minStartMs) continue;
    const { hard, soft } = classify(c, busy, opts.ctx, opts.bufferMinutes);
    if (hard.length > 0) continue;
    out.push({
      ...c,
      label: labelInTz(c.startUtc, opts.timezone),
      conflicts: soft,
    });
  }
  return out.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}

export type AvailabilityOptions = {
  fromISO?: string;
  toISO?: string;
  excludeBookingId?: string;
  now?: Date;
  settings?: CalendarSettings;
  /** 023 — Largo del hueco (duración del tipo). Sin él, `slotMinutes`. */
  durationMinutes?: number;
  /** 023 — Reglas de choque. Sin él, `strict` (lo de la 015: todo bloquea). */
  ctx?: ConflictContext;
  /** 023 — Ejecutor: la transacción del candado, si se corre dentro. */
  db?: AgendaDb;
};

export async function computeAvailability(
  organizationId: string,
  opts?: AvailabilityOptions
): Promise<SlotWithConflicts[]> {
  const settings = opts?.settings ?? (await getSettings(organizationId));
  const now = opts?.now ?? new Date();
  const tz = settings.timezone;

  const from = opts?.fromISO ?? todayInTz(now, tz);
  const to = opts?.toISO ?? addDaysISO(from, settings.maxDaysAhead);

  const candidates = buildCandidateSlots(
    settings,
    from,
    to,
    opts?.durationMinutes
  );
  if (candidates.length === 0) return [];

  const busy = await getBusyIntervals(
    organizationId,
    {
      // Un día antes: una cita larga de la víspera puede invadir el primero.
      fromUtc:
        zonedWallClockToUtc(addDaysISO(from, -1), "00:00", tz) ?? new Date(0),
      toUtc:
        zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz) ??
        new Date(now.getTime() + 86_400_000 * 61),
      excludeBookingId: opts?.excludeBookingId,
    },
    opts?.db
  );

  return classifySlots(candidates, busy, {
    now,
    minNoticeHours: settings.minNoticeHours,
    timezone: tz,
    ctx: opts?.ctx ?? STRICT,
    bufferMinutes: settings.bufferMinutes,
  });
}

/**
 * Re-valida que un instante concreto siga ofrecible. Se llama AL CONFIRMAR,
 * nunca al ofrecer. `excludeBookingId` permite reprogramar sin que la propia
 * cita se bloquee a sí misma. Devuelve el hueco con sus choques soft, o null
 * si no está en la rejilla, ya pasó o tiene un choque hard.
 *
 * Solo recalcula ±1 día alrededor del instante pedido.
 *
 * 023 — Dentro del candado por organización (con `db` = la transacción) esto
 * YA cierra la carrera, incluidos los traslapes parciales: ninguna otra
 * escritura de agenda del negocio cabe entre este SELECT y el INSERT. Los
 * índices únicos parciales quedan como red de seguridad.
 */
export async function findSlot(
  organizationId: string,
  whenISO: string,
  opts?: Omit<AvailabilityOptions, "fromISO" | "toISO">
): Promise<SlotWithConflicts | null> {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;

  const settings = opts?.settings ?? (await getSettings(organizationId));
  const dayInTz = todayInTz(new Date(target), settings.timezone);

  const slots = await computeAvailability(organizationId, {
    ...opts,
    fromISO: addDaysISO(dayInTz, -1),
    toISO: addDaysISO(dayInTz, 1),
    settings,
  });
  return slots.find((s) => Date.parse(s.startUtc) === target) ?? null;
}

/**
 * 023 — Choques de un intervalo concreto, SIN rejilla ni aviso mínimo. Para
 * lo que ya existe y vuelve a ocupar agenda (reasignar, `no_show → realizada`):
 * una cita fuera del horario actual o en el pasado no debe rechazarse por eso.
 */
export async function conflictsAt(
  organizationId: string,
  input: {
    startUtc: string;
    durationMinutes: number;
    ctx: ConflictContext;
    bufferMinutes: number;
    excludeBookingId?: string;
  },
  db?: AgendaDb
): Promise<Classification> {
  const start = Date.parse(input.startUtc);
  const candidate: SlotUtc = {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(start + input.durationMinutes * 60_000).toISOString(),
  };
  const busy = await getBusyIntervals(
    organizationId,
    {
      fromUtc: new Date(start - 86_400_000),
      toUtc: new Date(start + 86_400_000),
      excludeBookingId: input.excludeBookingId,
    },
    db
  );
  return classify(candidate, busy, input.ctx, input.bufferMinutes);
}

/**
 * Lo que ocupa agenda en un rango, con lo necesario para clasificar (tipo,
 * exclusividad, vendedor) y para explicar el choque (nombres). Acepta la
 * transacción del candado.
 */
export async function getBusyIntervals(
  organizationId: string,
  input: { fromUtc: Date; toUtc: Date; excludeBookingId?: string },
  db: AgendaDb = getDb()
): Promise<BusyItem[]> {
  const rows = await db
    .select({
      id: schema.booking.id,
      kind: schema.booking.kind,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
      typeId: schema.booking.appointmentTypeId,
      exclusive: schema.booking.exclusive,
      assignedUserId: schema.booking.assignedUserId,
      typeName: schema.appointmentType.name,
      sellerName: schema.user.name,
    })
    .from(schema.booking)
    .leftJoin(
      schema.appointmentType,
      eq(schema.booking.appointmentTypeId, schema.appointmentType.id)
    )
    .leftJoin(schema.user, eq(schema.booking.assignedUserId, schema.user.id))
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          // Canceladas y no-show liberan el hueco.
          inArray(schema.booking.status, [...OCCUPYING]),
          // Sandbox: una cita de prueba no consume la agenda real.
          eq(schema.booking.isTest, false),
          gte(schema.booking.scheduledAt, input.fromUtc),
          lte(schema.booking.scheduledAt, input.toUtc)
        )
      )
    );

  return rows
    .filter((r) => r.id !== input.excludeBookingId)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      startUtc: r.scheduledAt.toISOString(),
      endUtc: new Date(
        r.scheduledAt.getTime() + r.durationMinutes * 60_000
      ).toISOString(),
      typeId: r.typeId,
      exclusive: r.exclusive,
      assignedUserId: r.assignedUserId,
      typeName: r.typeName ?? null,
      sellerName: r.sellerName ?? null,
    }));
}
