"use client";

/**
 * 05/06 — N de no leídos (conversaciones, D-05-1) compartido por TODA la
 * pestaña: título, favicon y badge del menú leen este mismo valor, y
 * `/api/conversations/counts` se pide UNA vez por evento.
 *
 * - Fuera de la Bandeja lo pide `useUnreadIndicator` (montado en
 *   `AlertsProvider`).
 * - Dentro de la Bandeja, la lista ya pide `/counts` con sus filtros en cada
 *   evento, y `unreadConversations` es de la capa «solo visibilidad» (no
 *   depende de los filtros, contrato 06-0): la Bandeja reclama la fuente
 *   (`claimUnreadSource`) y publica lo que recibe; el indicador deja de pedir.
 * - Un 401 de cualquiera de los dos se publica como `"unauthorized"`: el
 *   indicador manda a /login (sesión revocada).
 */

export type UnreadValue = number | "unauthorized" | null;

let value: UnreadValue = null;
let owners = 0;
const listeners = new Set<() => void>();

export function getUnread(): UnreadValue {
  return value;
}

export function publishUnread(next: UnreadValue): void {
  if (next === value) return;
  value = next;
  for (const l of listeners) l();
}

export function subscribeUnread(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** ¿Otra parte de la pestaña (la Bandeja) ya mantiene el número al día? */
export function hasExternalUnreadSource(): boolean {
  return owners > 0;
}

/** La Bandeja toma la fuente mientras está montada. Devuelve cómo soltarla. */
export function claimUnreadSource(): () => void {
  owners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners = Math.max(0, owners - 1);
  };
}
