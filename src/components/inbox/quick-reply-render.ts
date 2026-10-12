/**
 * 09 — Respuestas rápidas en el cliente: render de variables, detección del
 * atajo `/` y filtrado del selector. Lógica pura, sin React: la cubre
 * `tests/unit/quick-reply-render.test.ts`.
 *
 * PROVISIONAL: el servidor (T-09-11) agregará estas funciones a
 * `src/lib/quick-replies.ts` con la MISMA semántica; al integrar se unifican
 * y este archivo pasa a reexportarlas.
 */

import { QUICK_REPLY_VAR_PATTERN, QUICK_REPLY_VARS } from "@/lib/quick-replies";
import { normalizeText } from "@/lib/search";
import type { QuickReplyDto } from "@/lib/types";

/** Valores de las variables. Ausente o vacío → cadena vacía al insertar. */
export type QuickReplyContext = {
  /** Primer nombre del contacto: `{{nombre}}`. */
  nombre?: string | null;
  /** Nombre completo del contacto: `{{nombre_completo}}`. */
  nombreCompleto?: string | null;
  /** Nombre de quien envía: `{{vendedor}}`. */
  vendedor?: string | null;
  /** Nombre de la Marca: `{{negocio}}`. */
  negocio?: string | null;
};

/** El patrón compartido es global (`g`): una copia nueva por uso, nunca `.test()`. */
function varPattern(): RegExp {
  return new RegExp(QUICK_REPLY_VAR_PATTERN.source, "g");
}

/**
 * Contexto de render a partir del nombre del contacto y de quien mira:
 * `{{nombre}}` es la primera palabra ("María López" → "María").
 */
export function quickReplyContext(
  contactName: string | null | undefined,
  viewer: { name: string; businessName: string }
): QuickReplyContext {
  const full = (contactName ?? "").trim();
  return {
    nombre: full.split(/\s+/)[0] ?? "",
    nombreCompleto: full,
    vendedor: viewer.name,
    negocio: viewer.businessName,
  };
}

/**
 * Sustituye `{{variable}}` (espacios tolerados dentro de las llaves). Una
 * variable sin valor queda como cadena vacía y los espacios dobles que deja
 * se colapsan (RF-09-24). Una variable desconocida se deja tal cual: el
 * servidor ya no permite guardarla.
 */
export function renderQuickReply(body: string, ctx: QuickReplyContext): string {
  const values: Record<string, string | null | undefined> = {
    nombre: ctx.nombre,
    nombre_completo: ctx.nombreCompleto,
    vendedor: ctx.vendedor,
    negocio: ctx.negocio,
  };
  return body
    .replace(varPattern(), (whole, name: string) =>
      name in values ? (values[name] ?? "").trim() : whole
    )
    .replace(/[ \t]{2,}/g, " ");
}

/** Variables del cuerpo que no están en `QUICK_REPLY_VARS` (sin repetir). */
export function findUnknownVars(body: string): string[] {
  const known = new Set<string>(QUICK_REPLY_VARS);
  const unknown: string[] = [];
  for (const m of body.matchAll(varPattern())) {
    const name = m[1];
    if (name && !known.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * ¿El cursor está sobre un atajo `/consulta`? Solo cuenta si la `/` va al
 * inicio del campo o tras un espacio/salto ("1/2 kilo" no dispara).
 * Devuelve la consulta (sin la barra, en minúsculas) y dónde empieza la `/`.
 */
export function slashQuery(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const start = Math.max(upto.lastIndexOf(" "), upto.lastIndexOf("\n"), upto.lastIndexOf("\t")) + 1;
  const token = upto.slice(start);
  if (!token.startsWith("/")) return null;
  const query = token.slice(1);
  if (!/^[a-z0-9_-]*$/i.test(query)) return null;
  return { query: query.toLowerCase(), start };
}

/**
 * Respuestas que casan con la consulta, por relevancia: primero las que
 * EMPIEZAN con ella en el atajo, luego las que la contienen en el atajo o el
 * título (sin distinguir acentos ni mayúsculas). Dentro de cada grupo, el
 * orden del catálogo (`position`). Consulta vacía → todas.
 */
export function matchQuickReplies(
  list: readonly QuickReplyDto[],
  query: string,
  limit = 8
): QuickReplyDto[] {
  const sorted = [...list].sort((a, b) => a.position - b.position);
  const q = normalizeText(query.trim());
  if (!q) return sorted.slice(0, limit);
  const prefix: QuickReplyDto[] = [];
  const contains: QuickReplyDto[] = [];
  for (const r of sorted) {
    const shortcut = normalizeText(r.shortcut);
    if (shortcut.startsWith(q)) prefix.push(r);
    else if (shortcut.includes(q) || normalizeText(r.title).includes(q))
      contains.push(r);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * Reordenar en Ajustes (subir/bajar): mueve el elemento `from` a `to` y
 * devuelve SOLO los cambios de `position` necesarios para que el orden quede
 * 0..n-1 (los PATCH a mandar). Fuera de rango → sin cambios.
 */
export function movePositions(
  list: readonly QuickReplyDto[],
  from: number,
  to: number
): { id: string; position: number }[] {
  const sorted = [...list].sort((a, b) => a.position - b.position);
  if (from === to || !sorted[from] || !sorted[to]) return [];
  const [moved] = sorted.splice(from, 1);
  if (!moved) return [];
  sorted.splice(to, 0, moved);
  return sorted
    .map((r, position) => ({ id: r.id, position, prev: r.position }))
    .filter((r) => r.position !== r.prev)
    .map(({ id, position }) => ({ id, position }));
}

/**
 * Reemplaza el atajo `/consulta` (de `start` al cursor) por el texto ya
 * renderizado. Devuelve el texto nuevo y dónde queda el cursor.
 */
export function insertQuickReply(
  text: string,
  start: number,
  caret: number,
  rendered: string
): { text: string; caret: number } {
  const next = text.slice(0, start) + rendered + text.slice(caret);
  return { text: next, caret: start + rendered.length };
}
