import { parseBody, withAuth } from "@/lib/api";
import { categoryPatchSchema } from "@/lib/catalog";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import { deleteCategory, updateCategory } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = "Categoría no encontrada";

/**
 * 019 — Editar / borrar una categoría (solo Propietario, FR-901/906).
 *
 * PATCH `CategoryPatchBody` → 200 `{ category }` · 404 `not_found`
 *   · 422 `invalid_body`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found`. Sus productos quedan sin
 *   categoría (FR-908).
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, NOT_FOUND);
    if (bad) return bad;
    const body = await parseBody(req, categoryPatchSchema);
    if (!body.ok) return body.response;
    try {
      const category = await updateCategory(session.organizationId, id, body.data);
      return Response.json({ category });
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
      await deleteCategory(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
