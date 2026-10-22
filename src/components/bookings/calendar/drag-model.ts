import { dayHeading, hhmm, wallClock } from "@/lib/time/calendar";
import type { BusyItem } from "@/server/agenda/conflicts";
import type { Booking } from "../booking-look";
import { parseBookingError, type SlotConflict } from "../booking-logic";
import {
  instantAt,
  NO_SELLER,
  PREVIEW_LABEL,
  previewState,
  snapMinute,
  type CalendarHours,
  type CalView,
  type PreviewState,
} from "./calendar-model";

/**
 * 028 (Fase B) — Reglas PURAS del arrastre del calendario: qué se puede
 * arrastrar, a qué minuto salta, qué dice la vista previa, qué se manda al
 * servidor y cómo se lee su respuesta. Sin React ni dnd-kit (se prueba en
 * node). La verdad final la da `PATCH /api/bookings/[id]` `move`.
 */

export type DropState = "free" | "soft" | "reject";

/** Las citas que "ocupan" según lo que el usuario ve (activas, no de prueba). */
export function busyFromBookings(bookings: readonly Booking[]): BusyItem[] {
  return bookings
    .filter(
      (b) => (b.status === "agendada" || b.status === "realizada") && !b.isTest
    )
    .map((b) => {
      const start = Date.parse(b.scheduledAtUtc);
      return {
        id: b.id,
        kind: b.kind,
        startUtc: new Date(start).toISOString(),
        endUtc: new Date(start + b.durationMinutes * 60_000).toISOString(),
        typeId: b.type?.id ?? null,
        exclusive: b.exclusive,
        assignedUserId: b.assignedUser?.id ?? null,
        typeName: b.type?.name ?? null,
        sellerName: b.assignedUser?.name ?? null,
      };
    });
}

/**
 * ¿Se puede arrastrar? Sesiones agendadas, futuras y no de prueba; los
 * bloqueos (agendados) solo en Semana (en Día por vendedor son franjas de
 * todas las columnas). El tramo que continúa de la víspera no se agarra: se
 * arrastra desde su inicio.
 */
export function canDragBooking(
  b: Pick<Booking, "kind" | "status" | "isTest" | "scheduledAtUtc">,
  opts: { view: CalView; now: Date; continuesBefore?: boolean }
): boolean {
  if (opts.continuesBefore) return false;
  if (b.status !== "agendada" || b.isTest) return false;
  if (b.kind === "block") return opts.view === "semana";
  return Date.parse(b.scheduledAtUtc) > opts.now.getTime();
}

/** A5 — Un bloqueo salta a múltiplos de `slotMinutes` desde las 00:00. */
export function snapBlockMinute(minute: number, slotMinutes: number, durationMinutes: number): number {
  const slot = Math.max(5, slotMinutes);
  const max = Math.max(0, 1440 - Math.min(durationMinutes, 1440));
  const snapped = Math.round(minute / slot) * slot;
  return Math.min(Math.floor(max / slot) * slot, Math.max(0, snapped));
}

export type DropTarget = {
  /** Columna destino: el día (Semana) o el vendedor (Día; `none` = sin asignar). */
  columnKey: string;
  dayIso: string;
  /** Minuto del día crudo (antes del ajuste), de la coordenada Y. */
  rawMinute: number;
};

export type DropPreview = {
  state: DropState;
  /** Motivo fino (para el texto y para decidir sin servidor). */
  reason: PreviewState | "not_owner" | "covers";
  columnKey: string;
  dayIso: string;
  minute: number;
  startUtc: string | null;
  /** Vendedor destino (solo sesiones). */
  sellerId: string | null;
  conflicts: BusyItem[];
  /** "vie 23, 11:00 · Libre". */
  label: string;
};

const REASON_LABEL: Record<"not_owner" | "covers", string> = {
  not_owner: "Solo el Propietario reasigna",
  covers: "Cubrirá citas",
};

export function previewLabel(dayIso: string, minute: number, text: string): string {
  const h = dayHeading(dayIso);
  return `${h.weekday} ${h.day}, ${hhmm(minute)} · ${text}`;
}

/**
 * A1/A5/A6 — Lo que muestra la columna destino mientras se arrastra.
 *
 * Sesión: en Día por vendedor, otra columna = reasignar (solo Propietario;
 * para el Vendedor es rechazo). El estado sale de `previewState` con el
 * vendedor DESTINO: libre ⇒ free; choque con otro vendedor ⇒ soft (pedirá
 * confirmación); el resto ⇒ reject.
 *
 * Bloqueo (A5): cualquier hora alineada a `slotMinutes`; si pisa sesiones ⇒
 * soft ("Cubrirá N citas", pedirá confirmación); si no ⇒ free.
 */
export function dropPreview(input: {
  booking: Booking;
  view: CalView;
  owner: boolean;
  target: DropTarget;
  hours: CalendarHours;
  now: Date;
  bookings: readonly Booking[];
}): DropPreview {
  const { booking: b, target, hours } = input;
  const busy = busyFromBookings(input.bookings);

  if (b.kind === "block") {
    const minute = snapBlockMinute(target.rawMinute, hours.slotMinutes, b.durationMinutes);
    const startUtc = instantAt(target.dayIso, minute, hours.timezone);
    const start = startUtc ? Date.parse(startUtc) : NaN;
    const end = start + b.durationMinutes * 60_000;
    const covered = busy.filter(
      (i) =>
        i.kind === "session" &&
        i.id !== b.id &&
        Date.parse(i.startUtc) < end &&
        start < Date.parse(i.endUtc)
    );
    const soft = covered.length > 0;
    return {
      state: soft ? "soft" : "free",
      reason: soft ? "covers" : "free",
      columnKey: target.columnKey,
      dayIso: target.dayIso,
      minute,
      startUtc,
      sellerId: null,
      conflicts: covered,
      label: previewLabel(
        target.dayIso,
        minute,
        soft
          ? `Cubrirá ${covered.length} ${covered.length === 1 ? "cita" : "citas"}`
          : PREVIEW_LABEL.free
      ),
    };
  }

  const minute = snapMinute(target.dayIso, target.rawMinute, hours);
  const origin = b.assignedUser?.id ?? NO_SELLER;
  const reassigning = input.view === "dia" && target.columnKey !== origin;
  const sellerId = reassigning
    ? target.columnKey === NO_SELLER
      ? null
      : target.columnKey
    : (b.assignedUser?.id ?? null);

  if (reassigning && !input.owner) {
    return {
      state: "reject",
      reason: "not_owner",
      columnKey: target.columnKey,
      dayIso: target.dayIso,
      minute,
      startUtc: instantAt(target.dayIso, minute, hours.timezone),
      sellerId,
      conflicts: [],
      label: previewLabel(target.dayIso, minute, REASON_LABEL.not_owner),
    };
  }

  const p = previewState({
    dayIso: target.dayIso,
    minute,
    durationMinutes: b.durationMinutes,
    hours,
    now: input.now,
    busy,
    ctx: {
      mode: "staff",
      typeId: b.type?.id ?? null,
      typeExclusive: b.exclusive,
      sellerId,
    },
    excludeId: b.id,
  });
  const state: DropState =
    p.state === "free" ? "free" : p.state === "overlap" ? "soft" : "reject";
  return {
    state,
    reason: p.state,
    columnKey: target.columnKey,
    dayIso: target.dayIso,
    minute,
    startUtc: p.startUtc,
    sellerId,
    conflicts: p.conflicts,
    label: previewLabel(target.dayIso, minute, PREVIEW_LABEL[p.state]),
  };
}

/**
 * Estilo del envoltorio `position: fixed` del `DragOverlay`. dnd-kit mide ESE
 * nodo para la colisión y el minuto destino; vive dentro de un contenedor
 * `space-y-*` que le pondría `margin-top` (12 px con `space-y-3`) y lo bajaría
 * respecto del puntero: la cita caía una fila más abajo (y un arrastre solo
 * lateral, para reasignar, cambiaba la hora). Sin margen, sigue al puntero.
 */
export const DRAG_OVERLAY_STYLE = { margin: 0 } as const;

/** El cuerpo del `PATCH move`, o null si soltar no cambia nada. */
export function moveRequest(
  b: Booking,
  preview: Pick<DropPreview, "startUtc" | "sellerId">,
  opts: { view: CalView; confirmOverlap?: boolean }
): {
  action: "move";
  startUtc?: string;
  userId?: string | null;
  expectedStartUtc: string;
  confirmOverlap?: boolean;
} | null {
  if (!preview.startUtc) return null;
  const timeChanged = Date.parse(preview.startUtc) !== Date.parse(b.scheduledAtUtc);
  const sellerChanged =
    b.kind === "session" &&
    opts.view === "dia" &&
    preview.sellerId !== (b.assignedUser?.id ?? null);
  if (!timeChanged && !sellerChanged) return null;
  return {
    action: "move",
    ...(timeChanged ? { startUtc: preview.startUtc } : {}),
    ...(sellerChanged ? { userId: preview.sellerId } : {}),
    expectedStartUtc: b.scheduledAtUtc,
    ...(opts.confirmOverlap ? { confirmOverlap: true } : {}),
  };
}

/** La cita como se verá tras moverla (para el movimiento optimista). */
export type MoveOverride = {
  id: string;
  scheduledAtUtc: string;
  assignedUser: { id: string; name: string } | null;
};

export function applyOverride(
  bookings: readonly Booking[],
  override: MoveOverride | null
): Booking[] {
  if (!override) return [...bookings];
  return bookings.map((b) =>
    b.id === override.id
      ? { ...b, scheduledAtUtc: override.scheduledAtUtc, assignedUser: override.assignedUser }
      : b
  );
}

/** Lo que dice la respuesta del `move`, ya clasificado. */
export type MoveOutcome =
  | { kind: "ok"; label: string }
  | { kind: "overlap_warning"; message: string; conflicts: SlotConflict[] }
  | { kind: "error"; message: string };

const STALE_FALLBACK = "Otra persona ya movió esta cita. Recargamos el calendario.";

export function parseMoveResponse(status: number | null, body: unknown): MoveOutcome {
  if (status === null) return { kind: "error", message: "Sin conexión con el servidor. La cita volvió a su lugar." };
  if (status >= 200 && status < 300) {
    const label = (body as { label?: unknown } | null)?.label;
    return { kind: "ok", label: typeof label === "string" ? label : "" };
  }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (status === 409 && code === "stale") {
    const msg = (body as { error?: { message?: unknown } }).error?.message;
    return { kind: "error", message: typeof msg === "string" && msg ? msg : STALE_FALLBACK };
  }
  const failure = parseBookingError(status, body, "No se pudo mover la cita.");
  if (failure.kind === "overlap_warning") {
    return { kind: "overlap_warning", message: failure.message, conflicts: failure.conflicts };
  }
  return { kind: "error", message: failure.message };
}

/** La hora local (negocio) de un instante: para el aviso "Cita movida a …". */
export function wallLabel(startUtc: string, tz: string): string {
  const w = wallClock(startUtc, tz);
  return previewLabel(w.day, w.minutes, "").replace(/ · $/, "");
}
