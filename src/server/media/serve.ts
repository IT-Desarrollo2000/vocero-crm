import { apiError } from "@/lib/api";
import { inspectFile, type FileInspection } from "@/server/media/file-policy";

/**
 * 018 — Cómo se sirve un archivo de un cliente (FR-814). Lo usan
 * `GET /api/media/[assetId]`, `/api/bot/media/[mediaId]` y (Bloque 2) la URL
 * firmada de Instagram.
 *
 * El archivo lo eligió un tercero: aunque la política lo haya dejado pasar,
 * se sirve como si fuera hostil. `nosniff` impide que el navegador
 * reinterprete el tipo; la CSP `sandbox` deja sin origen ni guiones a lo que
 * se abra por URL directa (mismo criterio que el favicon); y solo
 * imagen/audio/video de la lista blanca se muestran inline: lo demás se
 * descarga.
 */

export type ServeOk = Extract<FileInspection, { ok: true }>;

/** Nombre ASCII seguro para `filename="…"` (sin comillas, barras ni control). */
export function asciiFileName(name: string): string {
  const clean = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w. -]/g, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, 150);
  return clean || "adjunto";
}

/** RFC 5987: `encodeURIComponent` deja pasar ' ( ) * !, que no son attr-char. */
function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** `content-disposition`: inline solo si es seguro; si no, descarga con nombre. */
export function contentDisposition(
  inspection: ServeOk,
  fileName?: string | null
): string {
  if (inspection.inlineSafe) return "inline";
  const name = fileName?.trim() || `adjunto.${inspection.ext}`;
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

/** Cabeceras seguras para servir un archivo YA inspeccionado. */
export function safeFileHeaders(input: {
  inspection: ServeOk;
  fileName?: string | null;
  length: number;
  cacheControl: string;
}): Record<string, string> {
  return {
    "content-type": input.inspection.mime,
    "content-length": String(input.length),
    "content-disposition": contentDisposition(input.inspection, input.fileName),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": input.cacheControl,
  };
}

/**
 * Re-inspecciona los bytes al servir: los assets anteriores al 018 guardaron
 * el MIME que declaró el remitente. Devuelve la inspección o el 415.
 */
export function inspectForServing(
  data: Uint8Array,
  declared: { fileName?: string | null; mime?: string | null }
): { ok: true; inspection: ServeOk } | { ok: false; reason: string; response: Response } {
  const inspection = inspectFile(data, declared);
  if (inspection.ok) return { ok: true, inspection };
  return { ok: false, reason: inspection.reason, response: blockedResponse(inspection.reason) };
}

/** 415 `blocked`: el archivo no pasó la política y no se entrega. */
export function blockedResponse(reason: string): Response {
  return apiError(415, "blocked", reason);
}

/** 410 `expired`: la caché de 30 días ya borró el binario. */
export function expiredResponse(): Response {
  return apiError(
    410,
    "expired",
    "El archivo se eliminó: los archivos se guardan 30 días"
  );
}
