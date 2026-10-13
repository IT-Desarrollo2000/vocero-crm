/**
 * 09 — Respuestas rápidas: lo que es SOLO de la interfaz (armar el contexto
 * desde la conversación, insertar en el compositor y reordenar en Ajustes).
 * Lógica pura, sin React: la cubre `tests/unit/quick-reply-render.test.ts`.
 *
 * El render de variables, la detección del atajo `/` y el filtrado del
 * selector viven en `src/lib/quick-replies.ts` (una sola fuente de verdad,
 * compartida con el servidor): impórtalos de ahí.
 */

import { firstName, type QuickReplyContext } from "@/lib/quick-replies";
import type { QuickReplyDto } from "@/lib/types";

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
    nombre: firstName(full),
    nombreCompleto: full,
    vendedor: viewer.name,
    negocio: viewer.businessName,
  };
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
