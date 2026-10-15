import { parseBody, withAuth } from "@/lib/api";
import { categoryCreateSchema } from "@/lib/catalog";
import { catalogErrorResponse } from "@/server/catalog/http";
import { createCategory } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

/**
 * 019 — Alta de categoría (solo Propietario, FR-901/906).
 *
 * POST `CategoryCreateBody` → 201 `{ category: CatalogCategoryDto }`
 *   · 422 `invalid_body`. Sin `position` → al final.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    const body = await parseBody(req, categoryCreateSchema);
    if (!body.ok) return body.response;
    try {
      const category = await createCategory(session.organizationId, body.data);
      return Response.json({ category }, { status: 201 });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
