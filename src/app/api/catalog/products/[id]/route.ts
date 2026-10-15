import { parseBody, withAuth } from "@/lib/api";
import { productPatchSchema } from "@/lib/catalog";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import { deleteProduct, updateProduct } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = "Producto no encontrado";

/**
 * 019 — Editar / borrar un producto (solo Propietario, FR-902/906/908).
 *
 * PATCH `ProductPatchBody` → 200 `{ product: CatalogProductDto }` (con sus
 *   variantes y archivos) · 404 `not_found` · 422 `invalid_body`
 *   · 422 `invalid_category` · 409 `duplicate_code`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found`. Se van sus variantes y
 *   archivos (y sus bytes del storage, best-effort); los atajos ligados
 *   quedan sin producto.
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, NOT_FOUND);
    if (bad) return bad;
    const body = await parseBody(req, productPatchSchema);
    if (!body.ok) return body.response;
    try {
      const product = await updateProduct(session.organizationId, id, body.data);
      return Response.json({ product });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);

export const DELETE = withAuth(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, NOT_FOUND);
    if (bad) return bad;
    try {
      await deleteProduct(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
