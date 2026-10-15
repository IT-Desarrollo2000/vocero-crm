import { withAuth } from "@/lib/api";
import { getCatalog } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

/**
 * 019 — Catálogo de la organización (FR-906): lectura para cualquier rol.
 *
 * GET → 200 `CatalogDto` (`{ categories, products, storage: { provider } }`):
 *   categorías, productos y, dentro de cada producto, variantes y archivos
 *   ordenados por `position`. Incluye inactivos (`active: false`).
 */
export const GET = withAuth(async (session) => {
  const catalog = await getCatalog(session.organizationId);
  return Response.json(catalog);
});
