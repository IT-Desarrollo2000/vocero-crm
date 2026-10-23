/**
 * 029 — Quién puede escribir en el catálogo de respuestas rápidas
 * (specs/029-pedidos-ventas, US-1/US-2, CA-1..CA-3). Lógica pura, sin
 * dependencias de servidor: la usan el store (autorización real) y la UI
 * (qué botones pintar).
 *
 * - Propietario: todo, siempre (como en 09/019).
 * - Vendedor: con el interruptor `sellersCreateQuickReplies` encendido, crea
 *   respuestas de texto y edita/borra SOLO las suyas. Las ligadas a un
 *   producto (`productId`/`attach`) y el orden (`position`) siguen siendo del
 *   Propietario. Una fila sin autor (`createdByUserId` null: el autor se
 *   borró) es solo del Propietario.
 */

import { isOwner, type Role } from "./roles";

export type QuickReplyViewer = { userId: string; role: Role };

/** Lo que la política mira de una fila guardada. */
export type QuickReplyOwnership = {
  createdByUserId: string | null;
  productId: string | null;
};

/** Campos de un body que el Vendedor no puede mandar. */
export type QuickReplySellerFields = {
  productId?: string | null;
  attach?: string | null;
  position?: number;
};

export function canCreateQuickReply(
  viewer: QuickReplyViewer,
  sellersEnabled: boolean
): boolean {
  return isOwner(viewer.role) || sellersEnabled;
}

export function canEditQuickReply(
  viewer: QuickReplyViewer,
  row: QuickReplyOwnership,
  sellersEnabled: boolean
): boolean {
  if (isOwner(viewer.role)) return true;
  return (
    sellersEnabled &&
    row.createdByUserId !== null &&
    row.createdByUserId === viewer.userId &&
    row.productId === null
  );
}

/**
 * Campos del body prohibidos para este viewer (vacío = permitido). Al
 * Vendedor: `productId`/`attach` NO nulos (el formulario de Ajustes manda
 * `productId: null` siempre) y cualquier `position` presente.
 */
export function forbiddenQuickReplyFields(
  viewer: QuickReplyViewer,
  input: QuickReplySellerFields
): ("productId" | "attach" | "position")[] {
  if (isOwner(viewer.role)) return [];
  const out: ("productId" | "attach" | "position")[] = [];
  if (input.productId !== undefined && input.productId !== null) out.push("productId");
  if (input.attach !== undefined && input.attach !== null) out.push("attach");
  if (input.position !== undefined) out.push("position");
  return out;
}
