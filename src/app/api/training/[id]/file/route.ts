import { apiError, withAuth } from "@/lib/api";
import { parseByteRange, TRAINING_RULES } from "@/lib/training";
import { blockedResponse, safeFileHeaders, type ServeOk } from "@/server/media/serve";
import { invalidTrainingId, trainingErrorResponse } from "@/server/training/http";
import { openTrainingFile } from "@/server/training/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * 034 — Los bytes de un material de capacitación (cualquier rol con sesión;
 * nunca hay enlaces públicos). Mismas cabeceras seguras que los archivos del
 * catálogo (`src/server/media/serve.ts`): `nosniff`, CSP `sandbox`, PDF como
 * DESCARGA con nombre legible («título».pdf), video e imagen inline, y
 * `Cache-Control: private` (un id nunca cambia de bytes: reemplazar crea otro).
 *
 * `Range` (obligatorio para video: Safari/iOS no reproduce sin él):
 *   `bytes=0-99` → 206 + `Content-Range: bytes 0-99/size`; fuera de límites →
 *   416 + `Content-Range: bytes *\/size`; sin `Range` → 200 completo. Siempre
 *   `Accept-Ranges: bytes`. Un 206 se topa a 8 MiB (`MAX_RANGE_CHUNK`).
 *
 * No se re-inspecciona al servir: la firma se revisó al subir (cada fila
 * nace de `inspectFile`), y un rango a media pista no tiene firma. Se sirve
 * con el MIME guardado, si sigue siendo uno de los de su tipo.
 *
 * → 404 `not_found` · 410 `file_missing` · 415 `blocked` · 503.
 */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const bad = invalidTrainingId(id);
  if (bad) return bad;
  try {
    const file = await openTrainingFile(session.organizationId, id);
    if (!file) return apiError(404, "not_found", "Material no encontrado");
    const { row, size } = file;
    if (!TRAINING_RULES[row.kind].mimes.includes(row.mimeType)) {
      return blockedResponse("Tipo de archivo no permitido");
    }
    const inspection: ServeOk = {
      ok: true,
      mime: row.mimeType,
      kind: row.kind === "video" ? "video" : row.kind === "help_image" ? "image" : "document",
      ext: EXT[row.mimeType] ?? "bin",
      // Solo PDF va como descarga; video e imagen se ven en la Ayuda.
      inlineSafe: row.kind !== "document",
    };
    const fileName = row.kind === "document" ? `${row.title}.${inspection.ext}` : null;
    const headers = (length: number) => ({
      ...safeFileHeaders({
        inspection,
        fileName,
        length,
        cacheControl: "private, max-age=86400",
      }),
      "accept-ranges": "bytes",
    });

    const range = parseByteRange(req.headers.get("range"), size);
    if (range.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${size}`,
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    }
    if (range.kind === "partial") {
      const data = await file.read(range.start, range.end);
      return new Response(new Uint8Array(data), {
        status: 206,
        headers: {
          ...headers(data.byteLength),
          "content-range": `bytes ${range.start}-${range.start + data.byteLength - 1}/${size}`,
        },
      });
    }
    const data = await file.readAll();
    return new Response(new Uint8Array(data), { headers: headers(data.byteLength) });
  } catch (err) {
    return trainingErrorResponse(err);
  }
});
