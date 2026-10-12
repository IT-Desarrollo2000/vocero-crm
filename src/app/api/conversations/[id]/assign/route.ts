import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 09 — Tomar / liberar / asignar / reasignar una conversación.
 * STUB del contrato 09-0 (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md,
 * sección "Contrato 09-0"): la guarda (sesión, ambos roles) ya es la
 * definitiva; la lógica llega en T-09-05 (09-A).
 *
 * Body `AssignBody` = `{ userId: string | null, expect?: "unassigned" }`.
 *   Vendedor: `userId = yo` (tomar; implica `expect: "unassigned"`) o
 *             `null` sobre la suya (liberar). Otro destino → 403 `forbidden`.
 *   Propietario: cualquier miembro o `null`, incondicional; con
 *             `expect: "unassigned"` se comporta como "tomar" (409 si ya
 *             tiene responsable).
 *
 * 200 `{ conversation: ConversationDto }` (idempotente: tomar la propia o
 *     liberar una sin asignar → 200 sin cambios y sin evento).
 * 403 `forbidden` · 404 `not_found` (no existe, no visible o `is_test`) ·
 * 409 `already_assigned` (`error.assignedTo` solo al Propietario) ·
 * 422 `invalid_body` / `invalid_assignee`.
 * Tras el commit publica `conversation.updated { conversation: { id } }`.
 */
export const POST = withAuth(async () =>
  apiError(501, "not_implemented", "Asignación de conversaciones: pendiente (09)")
);
