import { parseBody, withAuth } from "@/lib/api";
import { variantPatchSchema } from "@/lib/catalog";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import { deleteVariant, updateVariant } from "@/server/catalog/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = "Variante no encontrada";

/**
 * 019 — Editar / borrar una variante (solo Propietario, FR-903/906/908).
 *
 * PATCH `VariantPatchBody` → 200 `{ variant: CatalogVariantDto }`
 *   · 404 `not_found` · 422 `invalid_body` · 409 `duplicate_code`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found`. Se van sus archivos propios
 *   (y sus bytes, best-effort); los compartidos del producto se quedan.
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, NOT_FOUND);
    if (bad) return bad;
    const body = await parseBody(req, variantPatchSchema);
    if (!body.ok) return body.response;
    try {
      const variant = await updateVariant(session.organizationId, id, body.data);
      return Response.json({ variant });
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
      await deleteVariant(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
