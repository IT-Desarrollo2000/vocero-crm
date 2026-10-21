import { addDaysISO, todayInTz, weekdayKeyOf, WEEKDAYS } from "@/lib/time/slots";

/**
 * 025 (A4) — Barrera de horarios inventados. PURA: sin BD ni reloj propio.
 *
 * Incidente del 21-oct: el modelo escribió a mano "viernes 24, 10:00 / 10:30 /
 * 11:00" (el 24 era sábado y nada de eso se había ofrecido). El cliente eligió
 * y la reserva falló. Si un texto DEL MODELO trae una lista de horarios, el
 * pipeline no lo envía: lo convierte en una oferta real del motor.
 *
 * Conservadora a propósito (un falso positivo le roba la respuesta al
 * cliente). POSITIVO solo si se cumplen las tres:
 *  1. ≥2 horas en lista — al menos una `HH:MM` o tras "a las/las"; un número
 *     suelto ("10, 10:30 y 11") cuenta solo pegado a otra hora — separadas
 *     por viñeta, salto, coma, " y " u " o ";
 *  2. léxico de oferta en el mensaje (tengo, disponible, horarios, opciones,
 *     quedan, puedo ofrecer, le/te acomoda);
 *  3. y NO hay rango (`de X a Y`, `X a Y`, `entre X y Y`, `X-Y`) ni léxico de
 *     atención (abre/abrimos, cierra/cerramos, atiende/atendemos, horario(s)
 *     de atención, lunes a — singular y plural):
 *     eso es un horario de atención, no una oferta.
 *
 * El día se deduce del texto: el NOMBRE del día manda sobre el número ("viernes
 * 24" con el viernes siendo 23 ⇒ el viernes).
 */

export type InventedSlots = {
  /** Día deducido (YYYY-MM-DD, zona del negocio) o undefined si no nombra uno. */
  date?: string;
};

type Tok = { start: number; end: number; strong: boolean };

const OFFER_LEXICON =
  /\b(disponibles?|tengo|puedo ofrecer|horarios?|opciones|quedan|le acomoda|te acomoda)\b/i;
// Singular y plural: "Nuestros horarios: abre a las 9:00 y cierra a las 18:00"
// es un horario de atención aunque diga "horarios" y traiga dos horas en lista.
const ATTENTION_LEXICON =
  /\b(abre|abren|abrimos|cierra|cierran|cerramos|atiende|atienden|atendemos|horarios? de atenci[oó]n|lunes a)\b/i;

const H = String.raw`\d{1,2}(?::\d{2})?`;
const SUFFIX = String.raw`(?:\s*(?:[ap]\.?\s?m\.?|hrs?\.?|h)(?![a-z]))?`;
const RANGES: RegExp[] = [
  // "de 9:00 am a 6:00 pm", "de 9 a 6"
  new RegExp(String.raw`\bde\s+(?:las\s+)?${H}${SUFFIX}\s+a\s+(?:las\s+)?\d{1,2}`, "i"),
  // "9:00 a 18:00", "10 a 11"
  new RegExp(String.raw`(?<![\d:])${H}${SUFFIX}\s+a\s+(?:las\s+)?\d{1,2}(?![\d/])`, "i"),
  // "entre las 10 y las 12"
  new RegExp(String.raw`\bentre\s+(?:las\s+)?${H}${SUFFIX}\s+y\s+(?:las\s+)?\d{1,2}`, "i"),
  // "10-12", "9:00–14:00" (sin salto: una viñeta "- " en otra línea no es rango)
  new RegExp(String.raw`(?<![\d:])${H}${SUFFIX}[^\S\n]?[-–][^\S\n]?\d{1,2}(?::\d{2})?(?!\d)`, "i"),
];

/**
 * Separador de lista entre dos horas. El `;` NO: divide oraciones ("Su cita
 * queda a las 11:00; llegue a las 10:45").
 */
const LIST_SEPARATOR = /[,•·\n*|/]|\s(?:y|o)\s|(?:^|\s)-\s/i;
/** Fin de oración dentro del hueco: ya no es la misma lista. */
const SENTENCE_END = /[.!?;](?:\s|$)/;
/** Límite de oración o de línea (para ubicar el léxico de oferta). */
const BOUNDARY = /[.!?;](?=\s|$)|\n/g;
const MAX_GAP = 60;
/**
 * Un número seguido de un sustantivo es una cantidad, no una hora ("las 3
 * unidades blancas", "2 modelos").
 */
const NOUN_AFTER =
  /^\s+(?:de\s+)?(?:unidades?|autos?|carros?|coches?|camionetas?|veh[ií]culos?|modelos?|colores?|versiones?|piezas?|llantas?|plazas?|asientos?|puertas?|lugares?|veces|d[ií]as|semanas|meses|a[nñ]os|horas|minutos|personas|opciones|horarios|cajones|blancas?|blancos?|negras?|negros?|rojas?|rojos?|grises|azules)\b/i;

function collectTokens(text: string): Tok[] {
  const toks: Tok[] = [];
  const push = (start: number, end: number, strong: boolean) => {
    if (toks.some((t) => start < t.end && t.start < end)) return;
    if (NOUN_AFTER.test(text.slice(end))) return;
    toks.push({ start, end, strong });
  };
  // "a las 10" (fuerte) y "las 10" (débil: "quedan las 3…" no es una hora).
  // Primero: se come la HH:MM que contenga.
  for (const m of text.matchAll(/(\ba\s+)?\blas\s+(\d{1,2})(?::(\d{2}))?(?!\d)/gi)) {
    if (Number(m[2]) > 23) continue;
    push(m.index, m.index + m[0].length, Boolean(m[1]) || m[3] !== undefined);
  }
  // "10:30" (fuerte).
  for (const m of text.matchAll(/(?<![\d$:])(\d{1,2}):(\d{2})(?!\d)/g)) {
    if (Number(m[1]) <= 23 && Number(m[2]) <= 59) {
      push(m.index, m.index + m[0].length, true);
    }
  }
  // Número suelto (débil): ni dinero, ni fecha ("24 de octubre", "vie 23"),
  // ni cantidad.
  const weak =
    /(?<![\d$,.:/])\b(\d{1,2})\b(?![:\d/]|[,.]\d|\s*%|\s+de\s+[a-z]|\s*(?:km|kg|años|meses|mil|pesos|personas|opciones|horarios))/gi;
  for (const m of text.matchAll(weak)) {
    if (Number(m[1]) > 23) continue;
    const before = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|lun|mar|mi[eé]|jue|vie|s[aá]b|dom|el|del)\.?,?\s+$/.test(before)) {
      continue;
    }
    push(m.index, m.index + m[0].length, false);
  }
  return toks.sort((a, b) => a.start - b.start);
}

function listed(text: string, a: Tok, b: Tok): boolean {
  const gap = text.slice(a.end, b.start);
  if (gap.length > MAX_GAP) return false;
  if (SENTENCE_END.test(gap)) return false;
  return LIST_SEPARATOR.test(gap);
}

/** Inicios y fines de cada oración/línea del texto. */
function segments(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    out.push({ start, end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  out.push({ start, end: text.length });
  return out;
}

/**
 * ¿El léxico de oferta acompaña a esta lista? Debe estar en la(s) misma(s)
 * oración/línea(s) que las horas; o en la oración inmediata anterior si la
 * lista la continúa ("Para el viernes tengo:\n• 10:00\n• 10:30", "¿Cuál le
 * acomoda? • 10:00 • 10:30").
 */
function offerNearby(text: string, run: Tok[]): boolean {
  const segs = segments(text);
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const i = segs.findIndex((s) => first.start >= s.start && first.start < s.end);
  const j = segs.findIndex((s) => last.end > s.start && last.end <= s.end);
  if (i < 0 || j < 0) return false;
  const region = text.slice(segs[i]!.start, segs[j]!.end);
  if (OFFER_LEXICON.test(region)) return true;
  const prev = i > 0 ? text.slice(segs[i - 1]!.start, segs[i - 1]!.end) : "";
  const continues =
    /^\s*[•·*\-]/.test(region) || /[:?]\s*$/.test(prev.trimEnd());
  return continues && OFFER_LEXICON.test(prev);
}

/** ¿Hay ≥2 horas en lista con al menos una fuerte, con léxico de oferta al lado? */
function hasTimeList(text: string): boolean {
  const toks = collectTokens(text);
  let run: Tok[] = [];
  const ok = (r: Tok[]) =>
    r.length >= 2 && r.some((t) => t.strong) && offerNearby(text, r);
  for (const t of toks) {
    const prev = run[run.length - 1];
    if (prev && listed(text, prev, t)) {
      run.push(t);
    } else {
      if (ok(run)) return true;
      run = [t];
    }
  }
  return ok(run);
}

/**
 * ¿Este texto del modelo trae una lista de horarios inventada? `null` si no;
 * si sí, el día que nombra (si nombra uno).
 */
export function detectInventedSlots(
  text: string | null | undefined,
  opts: { now: Date; timezone: string }
): InventedSlots | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  // Las fechas ISO no son horas ni rangos ("2026-10-23").
  const clean = raw.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  if (!OFFER_LEXICON.test(clean)) return null;
  if (ATTENTION_LEXICON.test(clean)) return null;
  if (RANGES.some((r) => r.test(clean))) return null;
  if (!hasTimeList(clean)) return null;
  const date = deduceDay(raw, opts.now, opts.timezone);
  return date ? { date } : {};
}

// ── Día ──────────────────────────────────────────────────────────────────

const DAY_INDEX: Record<string, number> = {
  lunes: 0,
  lun: 0,
  martes: 1,
  mar: 1,
  miercoles: 2,
  mie: 2,
  jueves: 3,
  jue: 3,
  viernes: 4,
  vie: 4,
  sabado: 5,
  sab: 5,
  domingo: 6,
  dom: 6,
};

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Día que nombra el texto, en la zona del negocio:
 *  1. nombre del día ("viernes", "vie 23") ⇒ el próximo con ese nombre (hoy
 *     incluido: "el miércoles" dicho un miércoles es hoy; si ya no hay
 *     huecos, el motor ofrece el más cercano);
 *  2. "pasado mañana" / "mañana" (no "por la mañana") / "hoy";
 *  3. "24 de octubre" ⇒ esa fecha (del año siguiente si ya pasó);
 *  4. "el 24" ⇒ ese día de este mes (o del siguiente si ya pasó).
 */
export function deduceDay(text: string, now: Date, tz: string): string | undefined {
  const t = fold(text);
  const today = todayInTz(now, tz);

  const full = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.exec(t);
  const abbr = /\b(lun|mar|mie|jue|vie|sab|dom)\.?,?\s+\d{1,2}\b/.exec(t);
  const name = full && (!abbr || full.index <= abbr.index) ? full[1] : abbr?.[1];
  if (name) {
    const target = DAY_INDEX[name];
    const todayKey = weekdayKeyOf(today, tz);
    const todayIdx = todayKey ? WEEKDAYS.indexOf(todayKey) : -1;
    if (target !== undefined && todayIdx >= 0) {
      return addDaysISO(today, (target - todayIdx + 7) % 7);
    }
  }

  if (/\bpasado manana\b/.test(t)) return addDaysISO(today, 2);
  if (/(?<!\b(?:la|por la|en la|de la)\s)\bmanana\b/.test(t)) {
    return addDaysISO(today, 1);
  }
  if (/\bhoy\b/.test(t)) return today;

  const [y, mo, d] = today.split("-").map(Number) as [number, number, number];
  const withMonth = /\b(\d{1,2})\s+de\s+([a-z]+)\b/.exec(t);
  if (withMonth) {
    const month = MONTHS[withMonth[2]!];
    const day = Number(withMonth[1]);
    if (month && day >= 1 && day <= 31) {
      let iso = isoOf(y, month, day);
      if (iso < today) iso = isoOf(y + 1, month, day);
      return iso;
    }
  }
  const bare = /\bel\s+(\d{1,2})\b(?!:)/.exec(t);
  if (bare) {
    const day = Number(bare[1]);
    if (day >= 1 && day <= 31) {
      if (day >= d) return isoOf(y, mo, day);
      return mo === 12 ? isoOf(y + 1, 1, day) : isoOf(y, mo + 1, day);
    }
  }
  return undefined;
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
