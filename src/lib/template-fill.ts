/**
 * 031 — Ventana cerrada en 3 pasos: lo que la pantalla le dice al vendedor
 * sobre una plantilla (nombre legible, de qué va cada espacio, el nombre ya
 * puesto y cómo le va a llegar al cliente). Puro y sin React: lo usa
 * `template-sender.tsx` y lo cubre `tests/unit/template-fill.test.ts`.
 *
 * El conteo de variables y el render que se ENVÍA siguen en
 * `src/lib/templates.ts` (los comparte el servidor).
 */

import { firstName } from "@/lib/quick-replies";

/** `{{n}}` con espacios opcionales, igual que `src/lib/templates.ts`. */
const VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;

/** Lo que se ve en lugar de un espacio por llenar. */
export const BLANK = "___";

/**
 * Primer nombre para hablarle al vendedor del cliente ("Laura Gómez" →
 * "Laura"). null si no hay un nombre de verdad: un teléfono o un id de canal
 * no se usan como nombre ("Hola +52…" se ve peor que "Hola ___").
 */
export function displayFirstName(name: string | null | undefined): string | null {
  const first = firstName(name);
  if (!first || /[\d+@:]/.test(first)) return null;
  return first;
}

/**
 * `seguimiento_cotizacion` → «Seguimiento cotizacion»: guiones bajos a
 * espacios y la primera letra en mayúscula. No inventa acentos ni artículos.
 */
export function humanizeTemplateName(name: string): string {
  const spaced = name.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return name;
  return spaced.charAt(0).toLocaleUpperCase("es") + spaced.slice(1);
}

/**
 * Nombre legible de cada plantilla por id. El idioma va entre paréntesis
 * solo cuando dos comparten el mismo nombre legible (la misma plantilla en
 * español e inglés, p. ej.).
 */
export function templateLabels(
  templates: readonly { id: string; name: string; language: string }[]
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const t of templates) {
    const h = humanizeTemplateName(t.name);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const t of templates) {
    const h = humanizeTemplateName(t.name);
    out.set(t.id, (counts.get(h) ?? 0) > 1 ? `${h} (${t.language})` : h);
  }
  return out;
}

/** Cuerpo con cada `{{n}}` mostrado como «___». */
export function blankBody(body: string): string {
  return body.replace(VARIABLE, BLANK);
}

/**
 * Inicio del cuerpo para la tarjeta del paso 1: los espacios como «___» y,
 * si es largo, cortado en una palabra con «…».
 */
export function templateSnippet(body: string, max = 90): string {
  const text = blankBody(body).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()} …`;
}

/**
 * Unas palabras alrededor del espacio `n` («Hola ___», «la cotización de
 * ___»), para que el vendedor sepa qué va ahí. Los demás espacios se ven
 * como «___». Si se cortó texto, «…» en ese lado. null si `n` no está.
 */
export function variableContext(
  body: string,
  n: number,
  opts: { before?: number; after?: number } = {}
): string | null {
  const before = opts.before ?? 3;
  const after = opts.after ?? 2;
  const marker = "\u0000";
  let found = false;
  const marked = body.replace(VARIABLE, (_m, idx: string) => {
    if (Number(idx) === n && !found) {
      found = true;
      return marker;
    }
    return BLANK;
  });
  if (!found) return null;
  const at = marked.indexOf(marker);
  // Solo la oración del espacio: cortar en el último/primer signo de cierre.
  const left = marked.slice(0, at).split(/[.!?¡¿\n]/).pop() ?? "";
  const right = marked.slice(at + 1).split(/[.!?\n]/)[0] ?? "";
  const leftWords = left.trim() ? left.trim().split(/\s+/) : [];
  const rightWords = right.trim() ? right.trim().split(/\s+/) : [];
  const l = leftWords.slice(-before);
  const r = rightWords.slice(0, after);
  // Puntuación pegada al espacio («Hola ___,»): se queda junto a él.
  const attached = /^[,;:)]/.test(right) ? "" : " ";
  const head = (leftWords.length > l.length ? "…" : "") + l.join(" ");
  const tail = r.join(" ") + (rightWords.length > r.length ? "…" : "");
  return `${head}${head ? " " : ""}${BLANK}${tail ? attached + tail : ""}`.trim();
}

/** Saludo justo antes de `{{1}}`: ahí casi siempre va el nombre del cliente. */
const GREETING_BEFORE_1 =
  /(hola|buen[oa]s(?:\s+(?:d[ií]as|tardes|noches))?|estimad[oa]s?|querid[oa]s?)\s*,?\s*\{\{\s*1\s*\}\}/i;

/**
 * Valor inicial de `{{1}}`: el primer nombre del contacto, SOLO si el cuerpo
 * lo pide con un saludo («Hola {{1}}») y el contacto tiene un nombre de
 * verdad. Si no, null (el vendedor lo llena).
 */
export function greetingPrefill(
  body: string,
  contactName: string | null | undefined
): string | null {
  if (!GREETING_BEFORE_1.test(body)) return null;
  return displayFirstName(contactName);
}

export type PreviewSegment =
  | { kind: "text"; text: string }
  | { kind: "value"; n: number; text: string }
  | { kind: "missing"; n: number };

/**
 * Vista previa «Así le va a llegar»: el cuerpo partido en texto, valores ya
 * llenos (en negrita en la UI) y espacios que faltan.
 */
export function previewSegments(body: string, values: readonly string[]): PreviewSegment[] {
  const out: PreviewSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(VARIABLE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: body.slice(last, at) });
    const n = Number(m[1]);
    const value = (values[n - 1] ?? "").trim();
    out.push(value ? { kind: "value", n, text: value } : { kind: "missing", n });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

/** Número (1..n) del primer espacio vacío, o null si todos están llenos. */
export function firstMissing(values: readonly string[]): number | null {
  const i = values.findIndex((v) => !v.trim());
  return i === -1 ? null : i + 1;
}
