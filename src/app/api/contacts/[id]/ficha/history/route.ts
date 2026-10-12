import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 04 — Bitácora de la ficha del contacto (`ficha_event`), ambos roles.
 * STUB del contrato 04-0 (dev-tasks/04-el-agente-llena-la-ficha.md, sección
 * "Contrato 04-0"); la lógica llega en T-04-09.
 *
 * GET → 200 `FichaHistoryResponse` (últimos 50, más reciente primero) · 404
 * `not_found` si el contacto no es de la organización.
 */
export const GET = withAuth(async () =>
  apiError(501, "not_implemented", "Historial de la ficha: pendiente (04)")
);
