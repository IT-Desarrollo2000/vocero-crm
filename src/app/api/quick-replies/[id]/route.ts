import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 09 — Editar / borrar una respuesta rápida (solo Propietario).
 * STUB del contrato 09-0 (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md,
 * sección "Contrato 09-0"): las guardas ya son las definitivas; la lógica
 * llega en T-09-12 (09-A).
 *
 * PATCH `QuickReplyPatchBody` (parcial; reordenar = cambiar `position`) →
 *   200 `{ quickReply: QuickReplyDto }` · 404 `not_found` · 422 `invalid_body`
 *   · 422 `unknown_variable` · 409 `duplicate_shortcut`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found`.
 */
export const PATCH = withAuth(
  async () => apiError(501, "not_implemented", "Respuestas rápidas: pendiente (09)"),
  { role: "owner" }
);

export const DELETE = withAuth(
  async () => apiError(501, "not_implemented", "Respuestas rápidas: pendiente (09)"),
  { role: "owner" }
);
