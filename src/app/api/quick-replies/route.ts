import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 09 — Catálogo de respuestas rápidas de la organización.
 * STUB del contrato 09-0 (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md,
 * sección "Contrato 09-0"): las guardas ya son las definitivas; la lógica
 * llega en T-09-12 (09-A).
 *
 * GET (cualquier rol) → 200 `{ quickReplies: QuickReplyDto[] }` ordenadas por
 *   `position` asc, luego `createdAt` asc.
 * POST (Propietario) `QuickReplyCreateBody` → 201 `{ quickReply: QuickReplyDto }`
 *   · 422 `invalid_body` · 422 `unknown_variable` (nombra la variable)
 *   · 409 `duplicate_shortcut`.
 */
export const GET = withAuth(async () =>
  apiError(501, "not_implemented", "Respuestas rápidas: pendiente (09)")
);

export const POST = withAuth(
  async () => apiError(501, "not_implemented", "Respuestas rápidas: pendiente (09)"),
  { role: "owner" }
);
