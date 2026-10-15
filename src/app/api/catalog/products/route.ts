import { parseBody, withAuth } from "@/lib/api";
import { productCreateSchema } from "@/lib/catalog";
import { catalogErrorResponse } from "@/server/catalog/http";
import { createProduct } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

/**
 * 019 — Alta de producto (solo Propietario, FR-902/904/906).
 *
 * POST `ProductCreateBody` → 201 `{ product: CatalogProductDto }`
 *   · 422 `invalid_body` · 422 `invalid_category` · 409 `duplicate_code`
 *   (el código choca, sin distinguir mayúsculas, con otro producto o variante).
 */
export const POST = withAuth(
  async (session, req: Request) => {
    const body = await parseBody(req, productCreateSchema);
    if (!body.ok) return body.response;
    try {
      const product = await createProduct(session.organizationId, body.data);
      return Response.json({ product }, { status: 201 });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
