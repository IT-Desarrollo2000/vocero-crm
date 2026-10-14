import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { graphRequest, graphRequestForm, MetaApiError } from "@/lib/meta/client";
import {
  getCredentialsByOrg,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { inspectFile, MAX_FILE_BYTES } from "@/server/media/file-policy";
import { MediaFetchError } from "@/server/media/fetch-error";
import { downloadSourceUrl } from "@/server/media/source-fetch";

export { MediaFetchError };

/**
 * 008 — Única frontera de media con la Graph API (constitución II: todo el
 * tráfico a Meta pasa por adaptadores dedicados) + persistencia en el volumen
 * local `MEDIA_DIR`. Meta expira sus archivos (entrantes a los 7 días, URLs
 * de minutos).
 *
 * 018 — El disco es una CACHÉ de 30 días (`src/server/media/purge.ts`), y
 * nada entra en él sin pasar la política de archivos (`file-policy.ts`): el
 * tipo se decide por la firma, no por lo que declara el remitente.
 */

/* ---------- Disco local ---------- */

function assertSafeSegment(s: string): void {
  if (!/^[\w.-]+$/.test(s)) throw new Error(`segmento de ruta inválido: ${s}`);
}

/** Ruta absoluta del archivo de un asset dentro de MEDIA_DIR. */
export function mediaFilePath(organizationId: string, assetId: string): string {
  assertSafeSegment(organizationId);
  assertSafeSegment(assetId);
  return path.join(getEnv().MEDIA_DIR, organizationId, assetId);
}

export async function saveMediaFile(
  organizationId: string,
  assetId: string,
  data: Buffer | Uint8Array
): Promise<string> {
  const file = mediaFilePath(organizationId, assetId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return path.join(organizationId, assetId); // ruta relativa persistida en BD
}

export async function readMediaFile(
  organizationId: string,
  assetId: string
): Promise<Buffer> {
  return readFile(mediaFilePath(organizationId, assetId));
}

/* ---------- Descarga desde Graph (entrantes y echoes) ---------- */

type GraphMediaMeta = { url?: string; mime_type?: string; file_size?: number };

/**
 * Descarga un media de Graph: GET {mediaId} → url efímera → GET con Bearer.
 * El token JAMÁS sale del servidor.
 */
export async function downloadGraphMedia(
  token: string,
  waMediaId: string,
  maxBytes: number = MAX_FILE_BYTES
):Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  let meta: GraphMediaMeta;
  try {
    meta = await graphRequest<GraphMediaMeta>(waMediaId, { token });
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  if (meta.file_size && meta.file_size > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }

  let res: Response;
  try {
    res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok) {
    throw new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  return {
    data: buf,
    mimeType: meta.mime_type ?? res.headers.get("content-type"),
    fileSize: buf.byteLength,
  };
}

/**
 * Garantiza que el asset esté en disco (`fetchStatus=available`).
 * Se usa en la descarga in-process post-ingesta Y on-demand desde la ruta de
 * media. Nunca lanza hacia el webhook: el que llama decide qué hacer con el
 * resultado. Devuelve el asset actualizado o null si no se pudo.
 */
export async function ensureAssetAvailable(
  organizationId: string,
  assetId: string
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(eq(schema.mediaAsset.id, assetId))
    .limit(1);
  const asset = rows[0];
  if (!asset || asset.organizationId !== organizationId) return null;
  // 018: `expired` y `blocked` son finales. Re-descargar un expirado
  // deshace la caché de 30 días; un bloqueado no se vuelve seguro al reintentar.
  if (
    asset.fetchStatus === "available" ||
    asset.fetchStatus === "expired" ||
    asset.fetchStatus === "blocked"
  ) {
    return asset;
  }
  // 018: dos orígenes. WhatsApp → media id + token de la org; Messenger e
  // Instagram → URL del CDN de Meta, sin token y con lista de hosts
  // (`source-fetch.ts`). Se decide ANTES de pedir credenciales: una org
  // solo-Messenger no tiene las de WhatsApp. location/contacts: sin binario.
  let download: () => Promise<{ data: Buffer; mimeType: string | null; fileSize: number }>;
  if (asset.waMediaId) {
    const waMediaId = asset.waMediaId;
    const creds = await getCredentialsByOrg(organizationId);
    if (!creds) return null;
    download = () => downloadGraphMedia(creds.token, waMediaId);
  } else if (asset.sourceUrl) {
    const sourceUrl = asset.sourceUrl;
    download = () => downloadSourceUrl(sourceUrl);
  } else {
    return null;
  }

  try {
    const { data, mimeType, fileSize } = await download();

    // 018 (FR-806): la firma decide. Bloqueado → el binario NO toca el disco.
    const inspection = inspectFile(data, {
      fileName: asset.fileName,
      mime: asset.mimeType ?? mimeType,
    });
    if (!inspection.ok) {
      const blockedRows = await db
        .update(schema.mediaAsset)
        .set({
          fetchStatus: "blocked",
          fetchError: inspection.reason,
          fileSize,
          storagePath: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.mediaAsset.id, assetId))
        .returning();
      console.warn(`[media] asset ${assetId} bloqueado: ${inspection.reason}`);
      return blockedRows[0] ?? null;
    }

    const storagePath = await saveMediaFile(organizationId, assetId, data);
    const updated = await db
      .update(schema.mediaAsset)
      .set({
        storagePath,
        // El kind (p. ej. sticker) lo dice el mensaje; el MIME, los bytes.
        mimeType: inspection.mime,
        fileSize,
        fetchStatus: "available",
        fetchError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAsset.id, assetId))
      .returning();
    return updated[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.mediaAsset)
      .set({ fetchStatus: "failed", fetchError: message, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));
    console.warn(`[media] descarga del asset ${assetId} falló: ${message}`);
    return null;
  }
}

/* ---------- Subida a Graph (salientes) ---------- */

/**
 * Sube un archivo a Graph (`POST /{phone_number_id}/media`, multipart) y
 * devuelve el media id para usar en /messages. Errores → MetaApiError (la
 * capa de envío los traduce con las mismas reglas que el texto).
 */
export async function uploadGraphMedia(
  credentials: Credentials,
  file: { data: Buffer | Uint8Array; mimeType: string; fileName?: string }
): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  const bytes = new Uint8Array(file.data);
  form.set(
    "file",
    new Blob([bytes], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  const res = await graphRequestForm<{ id?: string }>(
    `${credentials.phoneNumberId}/media`,
    { token: credentials.token, form }
  );
  if (!res?.id) {
    throw new MetaApiError("Meta no devolvió ID del media subido", {
      status: 200,
    });
  }
  return res.id;
}
