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

/**
 * 032 — Segundos → «4 segundos», «17 minutos», «1 hora 5 minutos», «2 días
 * 3 horas»: la misma unidad y redondeo que `formatDuration`, pero en palabras
 * para las frases de los reportes.
 */
export function formatDurationWords(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return EMPTY_VALUE;
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (seconds < 59.5) return unit(Math.round(seconds), "segundo", "segundos");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minuto", "minutos");
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${unit(h, "hora", "horas")} ${unit(m, "minuto", "minutos")}` : unit(h, "hora", "horas");
  }
  const hours = Math.round(minutes / 60);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${unit(d, "día", "días")} ${unit(h, "hora", "horas")}` : unit(d, "día", "días");
}

/**
 * 032 — Un tiempo de espera en palabras, sin «mediana» ni «p90»: «la mitad en
 * menos de 4 segundos; casi siempre (9 de cada 10) en menos de 10 segundos».
 * Si las dos cifras dicen lo mismo, basta la primera. null sin mediana.
 */
export function waitInWords(
  p50Seconds: number | null | undefined,
  p90Seconds: number | null | undefined
): string | null {
  if (!isNum(p50Seconds) || p50Seconds < 0) return null;
  const half = formatDurationWords(p50Seconds);
  const most = isNum(p90Seconds) && p90Seconds >= 0 ? formatDurationWords(p90Seconds) : null;
  if (!most || most === half) return `la mitad en menos de ${half}`;
  return `la mitad en menos de ${half}; casi siempre (9 de cada 10) en menos de ${most}`;
}

/** 032 — «en estos 30 días», «hoy», «en este rango»: para los vacíos. */
export function rangePhrase(range: { preset: string; from: string; to: string }): string {
  switch (range.preset) {
    case "today":
      return "hoy";
    case "7d":
      return "en estos 7 días";
    case "30d":
      return "en estos 30 días";
    case "90d":
      return "en estos 90 días";
    default:
      return range.from === range.to ? "ese día" : "en este rango";
  }
}
