/**
 * 02 — Formato de las cifras del reporte. Regla de RF-02-05: lo que no se
 * puede calcular (denominador 0, dato ausente) se muestra «—», nunca `NaN`
 * ni un 0 % que mienta.
 *
 * Lógica pura (sin React) para poder probarla en unit.
 */

export const EMPTY_VALUE = "—";

const MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

function isNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** `n / d`, o `null` si no hay denominador (o algo no es número). */
export function ratio(
  n: number | null | undefined,
  d: number | null | undefined
): number | null {
  if (!isNum(n) || !isNum(d) || d <= 0) return null;
  return n / d;
}

/**
 * Proporción 0..1 → «25 %». Por debajo de 10 % con un decimal si no es
 * entero («2.5 %»), para que un 0.4 % de fallidas no se lea como 0 %.
 */
export function formatPercent(value: number | null | undefined): string {
  if (!isNum(value)) return EMPTY_VALUE;
  const pct = value * 100;
  const rounded = Math.round(pct);
  if (pct > 0 && pct < 10 && Math.abs(pct - rounded) >= 0.05) {
    return `${(Math.round(pct * 10) / 10).toFixed(1)} %`;
  }
  return `${rounded} %`;
}

export function formatCount(value: number | null | undefined): string {
  if (!isNum(value)) return EMPTY_VALUE;
  return Math.round(value).toLocaleString("es-MX");
}

/**
 * Segundos → «4 s», «12 min», «1 h 5 min», «2 d 3 h». Se redondea a la
 * unidad mostrada: a quien lee un reporte de 30 días no le sirven los
 * segundos de una respuesta de una hora.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return EMPTY_VALUE;
  if (seconds < 59.5) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const hours = Math.round(minutes / 60);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

function parts(day: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** `2026-10-12` → «12 oct». Sin `Date`: el día ya viene en la zona del negocio. */
export function formatDayShort(day: string): string {
  const p = parts(day);
  if (!p) return day;
  return `${p.d} ${MONTHS[p.m - 1] ?? ""}`.trim();
}

/** `2026-10-12` → «12 oct 2026». */
export function formatDayLong(day: string): string {
  const p = parts(day);
  if (!p) return day;
  return `${formatDayShort(day)} ${p.y}`;
}

/** «12 oct – 18 oct 2026» (o con ambos años si cambian). */
export function formatDayRange(from: string, to: string): string {
  if (from === to) return formatDayLong(from);
  const a = parts(from);
  const b = parts(to);
  if (a && b && a.y === b.y) return `${formatDayShort(from)} – ${formatDayLong(to)}`;
  return `${formatDayLong(from)} – ${formatDayLong(to)}`;
}

/** Fecha y hora de un instante en la zona del negocio; si la zona falla, en la del navegador. */
export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return date.toLocaleString("es-MX", { ...opts, timeZone });
  } catch {
    return date.toLocaleString("es-MX", opts);
  }
}
