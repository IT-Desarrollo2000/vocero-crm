import { hhmm, workingBands, weekdayKeyOfDate } from "@/lib/time/calendar";
import {
  expandWorkingDayToUtc,
  zonedWallClockToUtc,
  type Interval,
  type SlotUtc,
  type WeekdayKey,
} from "@/lib/time/slots";
import {
  classify,
  type BusyItem,
  type ConflictContext,
} from "@/server/agenda/conflicts";

/**
 * 028 — Modelo PURO del calendario de Citas (sin React ni fetch: se prueba en
 * `tests/unit/`, entorno node). La aritmética de fechas y tramos vive en
 * `lib/time/calendar.ts` (portado de upstream); aquí va lo propio de esta
 * pantalla: vista por defecto, rango visible (A3), filas, posición de cada
 * tramo, columnas por vendedor, color del tipo (A7) y la rejilla REAL de la
 * agenda para el arrastre de la Fase B (A1: inicios válidos y estado de la
 * vista previa).
 */

/* ----------------------------------------------------------------- vista */

export type CalView = "semana" | "dia" | "lista";

export const CAL_VIEWS: readonly CalView[] = ["semana", "dia", "lista"];

/** Llave de `localStorage` con la última vista elegida. */
export const VIEW_STORAGE_KEY = "vocero.bookings.view";

export function parseStoredView(raw: unknown): CalView | null {
  return typeof raw === "string" && (CAL_VIEWS as readonly string[]).includes(raw)
    ? (raw as CalView)
    : null;
}

/** Semana en computadora (≥ md); en celular, Día (decisión 2 del dueño). */
export function defaultView(isWide: boolean): CalView {
  return isWide ? "semana" : "dia";
}

/* ------------------------------------------------------ horario y rejilla */

/** `hours` de `GET /api/bookings?from=&to=`. */
export type CalendarHours = {
  weeklyHours: Partial<Record<WeekdayKey, Interval[]>>;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  timezone: string;
};

/** Rango visible cuando no hay horario ni citas que lo definan. */
export const FALLBACK_RANGE = { startMin: 9 * 60, endMin: 18 * 60 };

export type MinuteRange = {
  startMin: number;
  endMin: number;
  /** Dónde se coloca el scroll al abrir: la apertura más temprana. */
  scrollMin: number;
};

/**
 * A3 — De min(apertura, inicio de las citas cargadas) a max(cierre, fin de
 * las citas cargadas) en los días que se ven, redondeado a horas completas.
 * Así nada queda fuera de la vista (una cita de las 7:00 con apertura a las
 * 9:00 se ve) y no se pinta la madrugada vacía.
 */
export function visibleMinuteRange(
  weeklyHours: CalendarHours["weeklyHours"],
  days: readonly string[],
  segments: readonly { day: string; startMin: number; endMin: number }[]
): MinuteRange {
  let open = Infinity;
  let close = -Infinity;
  for (const d of days) {
    for (const b of workingBands(weeklyHours, d)) {
      open = Math.min(open, b.startMin);
      close = Math.max(close, b.endMin);
    }
  }
  let start = open;
  let end = close;
  const inView = new Set(days);
  for (const s of segments) {
    if (!inView.has(s.day)) continue;
    start = Math.min(start, s.startMin);
    end = Math.max(end, s.endMin);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ...FALLBACK_RANGE, scrollMin: FALLBACK_RANGE.startMin };
  }
  const startMin = Math.max(0, Math.floor(start / 60) * 60);
  const endMin = Math.min(1440, Math.ceil(end / 60) * 60);
  return {
    startMin,
    endMin,
    scrollMin: Number.isFinite(open) ? open : startMin,
  };
}

/** Inicio de cada fila (una por `slotMinutes`) dentro del rango visible. */
export function rowStarts(range: { startMin: number; endMin: number }, slotMinutes: number): number[] {
  const step = Math.max(5, slotMinutes);
  const out: number[] = [];
  for (let m = range.startMin; m < range.endMin && out.length < 300; m += step) out.push(m);
  return out;
}

/** Posición vertical (px) de un tramo, recortada al rango visible. */
export function segmentBox(
  seg: { startMin: number; endMin: number },
  range: { startMin: number; endMin: number },
  pxPerMin: number,
  minHeight = 18
): { top: number; height: number } {
  const start = Math.max(seg.startMin, range.startMin);
  const end = Math.min(seg.endMin, range.endMin);
  const top = (start - range.startMin) * pxPerMin;
  return { top, height: Math.max(minHeight, (end - start) * pxPerMin) };
}

/** Minuto del día de un punto vertical de la columna (para clic/arrastre). */
export function minuteAtOffset(
  offsetPx: number,
  range: { startMin: number; endMin: number },
  pxPerMin: number
): number {
  const m = range.startMin + offsetPx / pxPerMin;
  return Math.min(range.endMin, Math.max(range.startMin, m));
}

/** El instante UTC de "ese día a ese minuto" en la zona del NEGOCIO. */
export function instantAt(dayIso: string, minute: number, tz: string): string | null {
  const m = Math.round(minute);
  if (m < 0 || m >= 1440) return null;
  const d = zonedWallClockToUtc(dayIso, hhmm(m), tz);
  return d ? d.toISOString() : null;
}

/**
 * A1 — La rejilla del día tal como la arma el motor (`buildCandidateSlots`):
 * paso `slot + buffer` anclado al inicio de CADA intervalo y la cita
 * completa (`durationMinutes`) tiene que caber antes del cierre.
 */
export function gridStarts(
  dayIso: string,
  hours: CalendarHours,
  durationMinutes: number
): SlotUtc[] {
  const intervals = hours.weeklyHours[weekdayKeyOfDate(dayIso)] ?? [];
  if (intervals.length === 0) return [];
  const buffer = Math.max(0, hours.bufferMinutes);
  return expandWorkingDayToUtc(
    dayIso,
    intervals,
    hours.timezone,
    durationMinutes,
    buffer,
    hours.slotMinutes + buffer
  );
}

/** A1 — Los inicios que hoy se podrían reservar: la rejilla ≥ ahora + aviso mínimo. */
export function validStarts(
  dayIso: string,
  hours: CalendarHours,
  durationMinutes: number,
  now: Date
): SlotUtc[] {
  const min = now.getTime() + hours.minNoticeHours * 3_600_000;
  return gridStarts(dayIso, hours, durationMinutes).filter(
    (s) => Date.parse(s.startUtc) >= min
  );
}

/**
 * Fase B (arrastre) — El minuto al que "salta" un punto de la columna: dentro
 * de un intervalo hábil, al paso `slot + buffer` anclado a su apertura (el
 * mismo de la rejilla); fuera de horario, a múltiplos de `slotMinutes` desde
 * las 00:00, para que la vista previa pueda decir "fuera de horario".
 */
export function snapMinute(dayIso: string, minute: number, hours: CalendarHours): number {
  const step = hours.slotMinutes + Math.max(0, hours.bufferMinutes);
  for (const band of workingBands(hours.weeklyHours, dayIso)) {
    if (minute >= band.startMin && minute < band.endMin) {
      const k = Math.round((minute - band.startMin) / step);
      const lastK = Math.max(0, Math.floor((band.endMin - 1 - band.startMin) / step));
      return band.startMin + Math.min(k, lastK) * step;
    }
  }
  const slot = Math.max(5, hours.slotMinutes);
  return Math.min(1440 - slot, Math.max(0, Math.round(minute / slot) * slot));
}

/** Lo que muestra la celda destino mientras se arrastra (A1). */
export type PreviewState =
  | "free"
  | "overlap"
  | "taken"
  | "off_hours"
  | "no_fit"
  | "too_soon"
  | "closed_day";

export const PREVIEW_LABEL: Record<PreviewState, string> = {
  free: "Libre",
  overlap: "Ocupado por otro vendedor",
  taken: "Ocupado",
  off_hours: "Fuera de horario",
  no_fit: "No cabe antes del cierre",
  too_soon: "Demasiado pronto",
  closed_day: "Día cerrado",
};

export type PreviewInput = {
  dayIso: string;
  /** Minuto del día (hora de pared del negocio) ya ajustado con `snapMinute`. */
  minute: number;
  durationMinutes: number;
  hours: CalendarHours;
  now: Date;
  /** Lo que ocupa agenda (activas, no de prueba), como en el servidor. */
  busy: readonly BusyItem[];
  ctx: ConflictContext;
  /** La cita que se mueve: no choca consigo misma. */
  excludeId?: string;
};

/**
 * A1 — Estado de la vista previa, en el orden en que el servidor rechazaría:
 * día cerrado · fuera de horario · no cabe antes del cierre · demasiado
 * pronto · choque (hard ⇒ ocupado; soft ⇒ ocupado por otro vendedor, que
 * pedirá confirmación) · libre. El choque usa el MISMO motor que el servidor,
 * con el margen (`bufferMinutes`).
 */
export function previewState(input: PreviewInput): {
  state: PreviewState;
  startUtc: string | null;
  conflicts: BusyItem[];
} {
  const { dayIso, minute, durationMinutes, hours } = input;
  const startUtc = instantAt(dayIso, minute, hours.timezone);
  const bands = workingBands(hours.weeklyHours, dayIso);
  if (bands.length === 0) return { state: "closed_day", startUtc, conflicts: [] };
  const band = bands.find((b) => minute >= b.startMin && minute < b.endMin);
  if (!band) return { state: "off_hours", startUtc, conflicts: [] };
  if (minute + durationMinutes > band.endMin) {
    return { state: "no_fit", startUtc, conflicts: [] };
  }
  if (!startUtc) return { state: "off_hours", startUtc, conflicts: [] };
  const startMs = Date.parse(startUtc);
  if (startMs < input.now.getTime() + hours.minNoticeHours * 3_600_000) {
    return { state: "too_soon", startUtc, conflicts: [] };
  }
  const { hard, soft } = classify(
    {
      startUtc,
      endUtc: new Date(startMs + durationMinutes * 60_000).toISOString(),
    },
    input.busy.filter((b) => b.id !== input.excludeId),
    input.ctx,
    hours.bufferMinutes
  );
  if (hard.length > 0) return { state: "taken", startUtc, conflicts: hard };
  if (soft.length > 0) return { state: "overlap", startUtc, conflicts: soft };
  return { state: "free", startUtc, conflicts: [] };
}

/* ------------------------------------------------------- vendedor y color */

export const NO_SELLER = "none";

export type SellerColumn = { id: string; name: string };

type ColumnBooking = {
  kind: "session" | "block";
  assignedUser: { id: string; name: string } | null;
};

/** En qué columna de "Día por vendedor" cae una cita. */
export function columnOf(b: ColumnBooking): string {
  return b.assignedUser?.id ?? NO_SELLER;
}

/**
 * Columnas de "Día por vendedor". Propietario: todo el equipo (`sellers`) +
 * "Sin asignar". Vendedor: él + "Sin asignar" (+ la columna de otro vendedor
 * solo si trae una cita que él puede ver, p. ej. una que creó para otro). Con
 * un filtro de vendedor, solo las columnas que pide el filtro o que traen
 * citas visibles. Los bloqueos no definen columnas: cruzan todas.
 */
export function sellerColumns(input: {
  owner: boolean;
  viewerId: string;
  sellers: readonly SellerColumn[];
  bookings: readonly ColumnBooking[];
  filter: string;
}): SellerColumn[] {
  const { owner, viewerId, filter } = input;
  const base: SellerColumn[] = owner ? [...input.sellers] : [{ id: viewerId, name: "Yo" }];
  const seen = new Set(base.map((s) => s.id));
  const extras: SellerColumn[] = [];
  const needed = new Set<string>();
  for (const b of input.bookings) {
    if (b.kind !== "session") continue;
    const id = columnOf(b);
    needed.add(id);
    if (id !== NO_SELLER && !seen.has(id) && b.assignedUser) {
      seen.add(id);
      extras.push({ id, name: b.assignedUser.name || "Vendedor" });
    }
  }
  const all = [...base, ...extras, { id: NO_SELLER, name: "Sin asignar" }];
  if (filter === "all") return all;
  const wanted =
    filter === "mine" ? viewerId : filter === NO_SELLER ? NO_SELLER : filter;
  return all.filter((c) => c.id === wanted || needed.has(c.id));
}

/** Iniciales para el bloque ("Ana López" ⇒ "AL"); ignora emojis y signos. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

/** Cuántos colores de tipo hay (`--cal-type-1..6` en globals.css). */
export const TYPE_COLOR_COUNT = 6;

/**
 * A7 — Color del tipo por HASH estable de su id (FNV-1a): el mismo tipo
 * conserva su color aunque cambie el orden o se agreguen tipos. 1..6; null
 * sin tipo (bloqueos y citas de la 015).
 */
export function typeColorIndex(typeId: string | null | undefined): number | null {
  if (!typeId) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < typeId.length; i++) {
    h ^= typeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % TYPE_COLOR_COUNT) + 1;
}
