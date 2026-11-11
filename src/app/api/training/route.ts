import { apiError, withAuth } from "@/lib/api";
import { TRAINING_MAX_BYTES, trainingUploadSchema } from "@/lib/training";
import { trainingErrorResponse } from "@/server/training/http";
import { addTrainingAsset, listTrainingAssets } from "@/server/training/store";

/** Holgura del multipart (límites, cabeceras de parte y campos de texto). */
const MULTIPART_OVERHEAD = 64 * 1024;

export const dynamic = "force-dynamic";

/**
 * 034 — Material de capacitación de la Ayuda.
 *
 * GET (cualquier rol) → 200 `{ assets: TrainingAssetDto[] }` (documentos,
 *   videos e imágenes, cada uno en su orden; sin `storage_key` ni proveedor).
 * POST (Propietario) multipart: `file` + `kind` (`document|video|help_image`)
 *   + `title?` + `topicId?` (id de `HELP_TOPICS`; obligatorio en imagen) +
 *   `durationSeconds?` (video, leído por el navegador) + `width?`/`height?`
 *   (imagen) + `replaceId?` (Reemplazar/Cambiar).
 *   → 201 `{ asset }` · 400 `invalid` (no es multipart) · 422 `invalid`
 *   (falta `file`) · 422 `invalid_body` (campos) · 413 `too_large` · 415
 *   `unsupported_type` (lo decide la FIRMA, no la extensión) · 409 · 404
 *   (`replaceId` ajeno) · 503 `storage_unavailable`. Si falla, no queda nada
 *   en BD ni en el almacenamiento.
 *
 * Route handler y no server action: las acciones topan el cuerpo en 1 MB.
 */
export const GET = withAuth(async (session) => {
  const assets = await listTrainingAssets(session.organizationId);
  return Response.json({ assets });
});

export const POST = withAuth(
  async (session, req: Request) => {
    const declaredLength = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > TRAINING_MAX_BYTES + MULTIPART_OVERHEAD) {
      return apiError(
        413,
        "too_large",
        `El archivo excede el tope de ${TRAINING_MAX_BYTES / (1024 * 1024)} MB`
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
    const text = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v.trim() : undefined;
    };
    const parsed = trainingUploadSchema.safeParse({
      kind: text("kind"),
      title: text("title"),
      topicId: text("topicId"),
      durationSeconds: text("durationSeconds"),
      width: text("width"),
      height: text("height"),
      replaceId: text("replaceId"),
    });
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return apiError(422, "invalid_body", detail);
    }

    try {
      const asset = await addTrainingAsset(session.organizationId, {
        data: Buffer.from(await file.arrayBuffer()),
        fileName: file.name,
        declaredMime: file.type || undefined,
        fields: parsed.data,
      });
      return Response.json({ asset }, { status: 201 });
    } catch (err) {
      return trainingErrorResponse(err);
    }
  },
  { role: "owner" }
);
