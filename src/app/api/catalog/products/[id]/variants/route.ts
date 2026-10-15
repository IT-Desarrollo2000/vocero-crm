import { parseBody, withAuth } from "@/lib/api";
import { variantCreateSchema } from "@/lib/catalog";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import { createVariant } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 019 — Alta de variante de un producto (solo Propietario, FR-903/904/906).
 *
 * POST `VariantCreateBody` → 201 `{ variant: CatalogVariantDto }`
 *   · 404 `not_found` (producto) · 422 `invalid_body` · 409 `duplicate_code`.
 */
export const POST = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, "Producto no encontrado");
    if (bad) return bad;
    const body = await parseBody(req, variantCreateSchema);
    if (!body.ok) return body.response;
    try {
      const variant = await createVariant(session.organizationId, id, body.data);
      return Response.json({ variant }, { status: 201 });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
