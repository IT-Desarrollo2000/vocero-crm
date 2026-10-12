import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 04 — Definición de los campos de la ficha (solo Propietario).
 * STUB del contrato 04-0 (dev-tasks/04-el-agente-llena-la-ficha.md, sección
 * "Contrato 04-0"): la guarda ya es la definitiva; la lógica llega en T-04-09.
 *
 * GET → 200 `FichaFieldsResponse`.
 * PUT `FichaFieldsPutBody` (validado con `fichaFieldsSchema`) → 200
 * `FichaFieldsResponse` · 422 `invalid_body` con detalle.
 */
export const GET = withAuth(
  async () => apiError(501, "not_implemented", "Campos de la ficha: pendiente (04)"),
  { role: "owner" }
);

export const PUT = withAuth(
  async () => apiError(501, "not_implemented", "Campos de la ficha: pendiente (04)"),
  { role: "owner" }
);
