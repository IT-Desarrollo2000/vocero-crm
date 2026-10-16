import { z } from "zod";
import {
  REPORT_DEFAULT_PRESET,
  REPORT_MAX_DAYS,
  REPORT_PRESET_DAYS,
  type ReportPreset,
  type ReportRangeDto,
} from "@/lib/reports";
import {
  addDaysISO,
  eachDateInRange,
  todayInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";

/**
 * 02 — Rango de un reporte (RF-02-01). Marco reutilizable por ventas y
 * anuncios.
 *
 * Días calendario en la zona del negocio; los límites UTC se calculan AQUÍ,
 * en Node, y viajan como parámetros: nunca `now()` ni aritmética de
 * intervalos en SQL contra columnas `timestamp` sin zona (dependería del
 * `TimeZone` de la sesión de Postgres).
 *
 *   ?range=7d|30d|90d                       N días locales que terminan HOY
 *   ?range=custom&from=YYYY-MM-DD&to=…      personalizado, `to` inclusive, ≤ 366 días
 *   ?range=7|30|90 · ?from=…&to=…           forma del .md, por compatibilidad
 *   (nada)                                  30 días
 *
 * Con `from`/`to` presentes, mandan sobre un preset. Cualquier otra cosa →
 * error (la API responde 422 `invalid_range`).
 */

export type ReportRange = {
  preset: ReportPreset;
  /** Primer día local (YYYY-MM-DD). */
  from: string;
  /** Último día local, inclusive. */
  to: string;
  tz: string;
  /** Medianoche local de `from`, en UTC. Inclusivo. */
  fromUtc: Date;
  /** Medianoche local de `to + 1`, en UTC. Exclusivo. */
  toUtc: Date;
  /** Cada día local del rango, en orden (90 en el preset 90d). */
  days: string[];
};

export type ParseRangeResult =
  | { ok: true; range: ReportRange }
  | { ok: false; message: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-30). */
const isoDay = z
  .string()
  .trim()
  .refine((s) => {
    if (!ISO_DAY.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "Fecha ilegible (usa YYYY-MM-DD)");

const querySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "custom", "7", "30", "90"]).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

type RangeParams =
  | URLSearchParams
  | { range?: string | null; from?: string | null; to?: string | null };

function read(params: RangeParams, key: "range" | "from" | "to"): string | undefined {
  const v = params instanceof URLSearchParams ? params.get(key) : params[key];
  return v === null || v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** Medianoche local de un día → instante UTC. */
function localMidnightUtc(day: string, tz: string): Date | null {
  return zonedWallClockToUtc(day, "00:00", tz);
}

/** Días calendario entre dos fechas ISO, ambas inclusive. */
function spanDays(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
    ) + 1
  );
}

function build(preset: ReportPreset, from: string, to: string, tz: string): ParseRangeResult {
  const fromUtc = localMidnightUtc(from, tz);
  const toUtc = localMidnightUtc(addDaysISO(to, 1), tz);
  if (!fromUtc || !toUtc || toUtc.getTime() <= fromUtc.getTime()) {
    return { ok: false, message: "Rango inválido" };
  }
  return {
    ok: true,
    range: { preset, from, to, tz, fromUtc, toUtc, days: eachDateInRange(from, to) },
  };
}

export function parseReportRange(
  params: RangeParams,
  tz: string,
  now: Date = new Date()
): ParseRangeResult {
  const parsed = querySchema.safeParse({
    range: read(params, "range"),
    from: read(params, "from"),
    to: read(params, "to"),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, message: `Rango inválido — ${detail}` };
  }
  const q = parsed.data;

  if (q.range === "custom" || q.from !== undefined || q.to !== undefined) {
    if (q.from === undefined || q.to === undefined) {
      return { ok: false, message: "Rango inválido — el personalizado exige `from` y `to`" };
    }
    if (q.from > q.to) {
      return { ok: false, message: "Rango inválido — `from` es posterior a `to`" };
    }
    if (spanDays(q.from, q.to) > REPORT_MAX_DAYS) {
      return { ok: false, message: `Rango inválido — máximo ${REPORT_MAX_DAYS} días` };
    }
    return build("custom", q.from, q.to, tz);
  }

  // "7" → "7d" (forma del .md); sin `range` → 30d.
  const preset = (q.range
    ? q.range.endsWith("d")
      ? q.range
      : `${q.range}d`
    : REPORT_DEFAULT_PRESET) as keyof typeof REPORT_PRESET_DAYS;
  const n = REPORT_PRESET_DAYS[preset];
  const today = todayInTz(now, tz);
  return build(preset, addDaysISO(today, -(n - 1)), today, tz);
}

/** Forma pública del rango (RF-02-04: zona y límites UTC usados). */
export function toRangeDto(range: ReportRange): ReportRangeDto {
  return {
    preset: range.preset,
    from: range.from,
    to: range.to,
    days: range.days,
    tz: range.tz,
    fromUtc: range.fromUtc.toISOString(),
    toUtc: range.toUtc.toISOString(),
  };
}

/**
 * 020 — El rango inmediatamente anterior con el mismo número de días locales
 * (para la variación del resumen). Calculado aquí, en Node, como el resto.
 * `null` si los límites no se pueden resolver.
 */
export function previousRange(range: ReportRange): ReportRange | null {
  const n = range.days.length;
  if (n < 1) return null;
  const built = build("custom", addDaysISO(range.from, -n), addDaysISO(range.from, -1), range.tz);
  return built.ok ? built.range : null;
}
