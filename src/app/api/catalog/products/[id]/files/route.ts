import { apiError, withAuth } from "@/lib/api";
import { catalogErrorResponse, invalidId } from "@/server/catalog/http";
import { addProductFile } from "@/server/catalog/store";
import { MAX_FILE_BYTES } from "@/server/media/file-policy";

/** Holgura del multipart (límites, cabeceras de parte, variantId). */
const MULTIPART_OVERHEAD = 64 * 1024;

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 019 — Sube una imagen o documento a un producto (solo Propietario, FR-905).
 * Multipart: `file` (requerido) + `variantId` (opcional; sin él = compartido
 * por todas las variantes).
 *
 * → 201 `{ file: CatalogFileDto }` · 404 `not_found` (producto)
 *   · 400 `invalid` (no es multipart) · 422 `invalid` (falta `file`)
 *   · 422 `invalid_variant` · 409 `too_many_files` · 413 `too_large`
 *   · 415 `unsupported_type` (razón legible: la decide la FIRMA, no la
 *   extensión) · 503 `storage_unavailable`. Si falla la validación o el
 *   storage, no queda nada en BD ni en el storage.
 */
export const POST = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidId(id, "Producto no encontrado");
    if (bad) return bad;

    const declaredLength = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES + MULTIPART_OVERHEAD) {
      return apiError(
        413,
        "too_large",
        `El archivo excede el tope de ${MAX_FILE_BYTES / (1024 * 1024)} MB`
      );
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      return apiError(400, "invalid", "Se esperaba multipart/form-data");
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return apiError(422, "invalid", "Falta el archivo (campo `file`)");
    }
    const variantRaw = form.get("variantId");
    const variantId =
      typeof variantRaw === "string" && variantRaw.trim() ? variantRaw.trim() : null;

    try {
      const created = await addProductFile(session.organizationId, id, {
        data: Buffer.from(await file.arrayBuffer()),
        fileName: file.name,
        declaredMime: file.type || undefined,
        variantId,
      });
      return Response.json({ file: created }, { status: 201 });
    } catch (err) {
      return catalogErrorResponse(err);
    }
  },
  { role: "owner" }
);
