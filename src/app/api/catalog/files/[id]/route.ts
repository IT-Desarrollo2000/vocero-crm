import { apiError, parseBody, withAuth } from "@/lib/api";
import { productFilePatchSchema } from "@/lib/catalog";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import {
  deleteProductFile,
  getCatalogFileForServing,
  updateProductFile,
} from "@/server/catalog/store";
import { inspectForServing, safeFileHeaders } from "@/server/media/serve";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = "Archivo no encontrado";

/**
 * 019 — Un archivo del catálogo (FR-905/908/914).
 *
 * GET (cualquier rol) → los bytes por proxy, con las cabeceras seguras de 018
 *   (`src/server/media/serve.ts`: tipo DETECTADO, `nosniff`, CSP `sandbox`;
 *   imágenes inline, documentos como descarga con nombre saneado)
 *   · 404 `not_found` (no es de la org) · 410 `file_missing` (fila sin
 *   bytes) · 415 `blocked` · 503 `storage_unavailable`.
 * PATCH (Propietario) `{ position?, variantId? }` → 200 `{ file }`
 *   · 404 `not_found` · 422 `invalid_body` · 422 `invalid_variant`.
 * DELETE (Propietario) → 200 `{ ok: true }` · 404 `not_found`; borra los
 *   bytes donde se guardó (best-effort) y sus ids reutilizables (CASCADE).
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const bad = invalidId(id, NOT_FOUND);
  if (bad) return bad;
  try {
    const found = await getCatalogFileForServing(session.organizationId, id);
    if (!found) return apiError(404, "not_found", NOT_FOUND);
    const { row, data } = found;
    const checked = inspectForServing(data, { fileName: row.fileName, mime: row.mimeType });
    if (!checked.ok) return checked.response;
    return new Response(new Uint8Array(data), {
      headers: safeFileHeaders({
        inspection: checked.inspection,
        fileName: row.fileName,
        length: data.byteLength,
        // Un id nunca cambia de contenido (reemplazar = archivo nuevo).
        cacheControl: "private, max-age=86400",
      }),
    });
  } catch (err) {
    return catalogErrorResponse(err);
  }
});

export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, NOT_FOUND);
    if (bad) return bad;
    const body = await parseBody(req, productFilePatchSchema);
    if (!body.ok) return body.response;
    try {
      const file = await updateProductFile(session.organizationId, id, body.data);
      return Response.json({ file });
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
      await deleteProductFile(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
