import { apiError, withAuth } from "@/lib/api";
import { IMPORT_MAX_BYTES } from "@/lib/contact-import";
import { previewImport } from "@/server/contact-import/preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Holgura del multipart (cabeceras de parte y el campo del evento). */
const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * 036 fase 2 — POST multipart `file` (.xlsx o .csv): vista previa de la lista
 * (Propietario). NO ESCRIBE NADA.
 *
 * → 200 `ImportPreviewDto` (renglones listos, con problema y repetidos, cada
 *   uno con su motivo; a quién se asigna cada vendedor; cuántos ya son
 *   contactos; columnas reconocidas e ignoradas)
 * · 400 `invalid` (no es multipart) · 422 `invalid` (falta `file`)
 * · 413 `too_large` (> 5 MB) · 415 `unsupported_type`
 * · 422 `unreadable` | `empty` | `no_header` | `too_many_rows` (> 2,000).
 * Cada error trae un `message` para mostrar tal cual.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > IMPORT_MAX_BYTES + MULTIPART_OVERHEAD) {
      return apiError(413, "too_large", "El archivo pesa más de 5 MB. Quítale hojas o columnas que no sean de la lista.");
    }
    const form = await req.formData().catch(() => null);
    if (!form) return apiError(400, "invalid", "Se esperaba multipart/form-data");
    const file = form.get("file");
    if (!(file instanceof File)) return apiError(422, "invalid", "Falta el archivo (campo `file`)");
    if (file.size > IMPORT_MAX_BYTES) {
      return apiError(413, "too_large", "El archivo pesa más de 5 MB. Quítale hojas o columnas que no sean de la lista.");
    }

    const result = await previewImport(session.organizationId, {
      data: Buffer.from(await file.arrayBuffer()),
      fileName: file.name.slice(0, 200),
    });
    if (!result.ok) {
      const status = result.code === "too_large" ? 413 : result.code === "unsupported_type" ? 415 : 422;
      return apiError(status, result.code, result.message);
    }
    return Response.json(result.preview);
  },
  { role: "owner" }
);
