/**
 * 02 — El rango del reporte en la URL (RF-02-09): un solo lugar que lee y
 * escribe `?range=` / `?from=&to=`, para que la página y la llamada a la API
 * hablen exactamente el mismo idioma.
 *
 * Forma que se EMITE: `range=today|7d|30d|90d` o `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`.
 * Forma que se ACEPTA al leer (enlaces viejos o escritos a mano): además
 * `range=7|30|90` y `from`/`to` sin `range`. Lo ilegible cae al default
 * (30 días), igual que la API sin parámetros: un enlace roto abre el reporte,
 * no una pantalla de error.
 *
 * Lógica pura (sin React) para poder probarla en unit.
 */

export type RangePreset = "today" | "7d" | "30d" | "90d";

export type RangeSelection =
  | { preset: RangePreset }
  | { preset: "custom"; from: string; to: string };

export const RANGE_PRESETS: readonly { preset: RangePreset; label: string }[] = [
  { preset: "today", label: "Hoy" },
  { preset: "7d", label: "7 días" },
  { preset: "30d", label: "30 días" },
  { preset: "90d", label: "90 días" },
];

export const DEFAULT_RANGE: RangeSelection = { preset: "30d" };

/** Tope del rango personalizado (RF-02-01). */
export const MAX_RANGE_DAYS = 366;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Día calendario `YYYY-MM-DD` real (rechaza `2026-02-30`). */
export function isIsoDay(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** Días del rango con ambos extremos incluidos (`from = to` → 1). */
export function daysInclusive(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

export type CustomRangeCheck =
  | { ok: true; days: number }
  | { ok: false; message: string };

/** Mismas reglas que la API (422 `invalid_range`), para avisar antes de pedir. */
export function validateCustomRange(from: string, to: string): CustomRangeCheck {
  if (!isIsoDay(from) || !isIsoDay(to)) {
    return { ok: false, message: "Elige una fecha de inicio y una de fin." };
  }
  const days = daysInclusive(from, to);
  if (days < 1) {
    return { ok: false, message: "La fecha de inicio va antes que la de fin." };
  }
  if (days > MAX_RANGE_DAYS) {
    return {
      ok: false,
      message: `El rango no puede pasar de ${MAX_RANGE_DAYS} días.`,
    };
  }
  return { ok: true, days };
}

type ParamsLike = { get(name: string): string | null };

function parsePreset(raw: string | null): RangePreset | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "today":
      return "today";
    case "7":
    case "7d":
      return "7d";
    case "30":
    case "30d":
      return "30d";
    case "90":
    case "90d":
      return "90d";
    default:
      return null;
  }
}

/** Lee el rango de la URL; lo inválido cae a 30 días. */
export function parseRangeParams(params: ParamsLike): RangeSelection {
  const preset = parsePreset(params.get("range"));
  if (preset) return { preset };
  const from = params.get("from");
  const to = params.get("to");
  const range = (params.get("range") ?? "").trim().toLowerCase();
  if ((range === "custom" || range === "") && from && to) {
    if (validateCustomRange(from, to).ok) return { preset: "custom", from, to };
  }
  return DEFAULT_RANGE;
}

/** Query string canónica (sin `?`), para la URL de la página y para la API. */
export function rangeToQuery(sel: RangeSelection): string {
  const params = new URLSearchParams();
  params.set("range", sel.preset);
  if (sel.preset === "custom") {
    params.set("from", sel.from);
    params.set("to", sel.to);
  }
  return params.toString();
}

export function sameRange(a: RangeSelection, b: RangeSelection): boolean {
  return rangeToQuery(a) === rangeToQuery(b);
}

/**
 * 021 — ¿Tiene sentido sugerir «Probar con 30 días» tras un 503? Solo si el
 * rango actual es MÁS largo que el default: con «Hoy», 7 días o un
 * personalizado corto, 30 días sería pedir más, no menos.
 */
export function canSuggestShorter(sel: RangeSelection): boolean {
  if (sel.preset === "90d") return true;
  if (sel.preset === "custom") return daysInclusive(sel.from, sel.to) > 30;
  return false;
}
