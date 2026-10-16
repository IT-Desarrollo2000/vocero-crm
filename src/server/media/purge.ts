import { rm } from "node:fs/promises";
import { and, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { mediaFilePath } from "@/server/whatsapp/media";

/**
 * 018 — Caché de 30 días (FR-815/817). El disco NO es archivo histórico: a
 * los `MEDIA_RETENTION_DAYS` días se borra el binario de cada adjunto y la
 * fila queda `expired` con `storage_path = null`. La fila se conserva: el
 * agente sigue viendo su marcador y el hilo dice "Archivo eliminado".
 *
 * Tarea de SISTEMA, no de una organización: recorre todas a la vez, así que
 * no pasa por `scoped()` (que existe para que una petición de un tenant no
 * vea filas de otro; aquí no hay petición ni tenant). Cada fila trae su
 * `organization_id` y el archivo se ubica con él — jamás se cruza.
 *
 * Solo borra `mediaFilePath(org, assetId)` de filas de `media_asset`: el
 * favicon de marca vive en `MEDIA_DIR/{org}/favicon` y NO tiene fila, así que
 * es inalcanzable desde aquí.
 *
 * Idempotente: `rm(..., { force: true })` no falla si el archivo ya no está, y
 * una fila `expired` no vuelve a seleccionarse. Por lotes, para no cargar
 * miles de filas de una vez tras una instancia apagada mucho tiempo.
 */

export const MEDIA_RETENTION_DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Estados con (o que podrían llegar a tener) binario en disco. `blocked` NO
 * está: un archivo bloqueado nunca se guarda, así que purgarlo no libera nada
 * y solo destruiría información — el hilo dejaría de decir "bloqueado por
 * seguridad" y el agente vería el tipo declarado, en el que no se confió.
 */
export const PURGEABLE_STATUSES = ["available", "pending", "failed"] as const;
/** location/contacts no tienen archivo: su payload es el mensaje. */
const BINARY_KINDS = ["image", "video", "audio", "document", "sticker"] as const;

export type MediaPurgeResult = {
  /** Corte usado: se purga lo creado ANTES de esta fecha. */
  cutoff: string;
  expired: number;
};

type PurgeRow = { id: string; organizationId: string };

export type MediaPurgeDeps = {
  /** Selecciona hasta `limit` filas purgables creadas antes de `cutoff`. */
  selectBatch?: (cutoff: Date, limit: number) => Promise<PurgeRow[]>;
  /** Marca las filas como expiradas. */
  markExpired?: (ids: string[], now: Date) => Promise<void>;
  removeFile?: (file: string) => Promise<void>;
  batchSize?: number;
};

/**
 * WHERE de lo purgable: creado antes del corte, con binario y en un estado
 * que pueda tenerlo, y que NO sea la miniatura de un anuncio de origen.
 *
 * 020 — La miniatura del creativo (`ad_attribution.image_asset_id`) se queda:
 * la copió el CRM del CDN de Meta, cuya URL caduca en días, así que borrarla
 * a los 30 días la perdería para siempre — y es una por anuncio, no un
 * adjunto por mensaje. La exclusión va por la clave foránea (no por el
 * `payload.origen`): si ya ninguna conversación la referencia (se borraron
 * por cascada), es un archivo huérfano y SÍ se purga. La subconsulta va en
 * SQL crudo —no un `db.select()`— para que el predicado se arme sin base
 * (lo fija `tests/unit/anuncio-origen.test.ts`); con paréntesis propios:
 * `notExists(sql…)` no los pone.
 */
export function purgeableCondition(cutoff: Date): SQL {
  const m = schema.mediaAsset;
  const a = schema.adAttribution;
  return and(
    lt(m.createdAt, cutoff),
    inArray(m.fetchStatus, [...PURGEABLE_STATUSES]),
    inArray(m.kind, [...BINARY_KINDS]),
    sql`not exists (select 1 from ${a} where ${a.imageAssetId} = ${m.id} and ${a.organizationId} = ${m.organizationId})`
  )!;
}

async function defaultSelectBatch(cutoff: Date, limit: number): Promise<PurgeRow[]> {
  const db = getDb();
  return db
    .select({ id: schema.mediaAsset.id, organizationId: schema.mediaAsset.organizationId })
    .from(schema.mediaAsset)
    .where(purgeableCondition(cutoff))
    .limit(limit);
}

async function defaultMarkExpired(ids: string[], now: Date): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mediaAsset)
    .set({ fetchStatus: "expired", storagePath: null, updatedAt: now })
    .where(inArray(schema.mediaAsset.id, ids));
}

/** Parsea `MEDIA_RETENTION_DAYS`: sin valor o ilegible → 30; mínimo 1 día. */
export function parseRetentionDays(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  if ((raw ?? "").trim() === "" || !Number.isFinite(n) || n <= 0) {
    return MEDIA_RETENTION_DEFAULT_DAYS;
  }
  return Math.max(1, Math.floor(n));
}

/**
 * Una vuelta de purga con el reloj `now`. Devuelve cuántos assets expiró.
 * El archivo se borra ANTES de marcar la fila: si el proceso cae a mitad,
 * la fila sigue purgable y la próxima vuelta lo completa.
 */
export async function runMediaPurge(
  now: Date,
  retentionDays: number = MEDIA_RETENTION_DEFAULT_DAYS,
  deps: MediaPurgeDeps = {}
): Promise<MediaPurgeResult> {
  const selectBatch = deps.selectBatch ?? defaultSelectBatch;
  const markExpired = deps.markExpired ?? defaultMarkExpired;
  const removeFile = deps.removeFile ?? ((file: string) => rm(file, { force: true }));
  const batchSize = deps.batchSize ?? 500;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  let expired = 0;
  for (;;) {
    const rows = await selectBatch(cutoff, batchSize);
    if (rows.length === 0) break;

    const done: string[] = [];
    for (const row of rows) {
      try {
        await removeFile(mediaFilePath(row.organizationId, row.id));
        done.push(row.id);
      } catch (err) {
        // Un archivo que no se pudo borrar (permisos, id raro) no detiene el
        // lote; su fila se queda como estaba y se reintenta la próxima hora.
        console.warn(`[media-purge] no se pudo borrar el asset ${row.id}:`, err);
      }
    }
    if (done.length > 0) await markExpired(done, now);
    expired += done.length;

    // Lote incompleto = no hay más. Si nada avanzó, cortar: repetir el mismo
    // lote sería un bucle infinito.
    if (rows.length < batchSize || done.length === 0) break;
  }

  if (expired > 0) {
    console.log(`[media-purge] ${expired} adjunto(s) expirado(s) (corte ${cutoff.toISOString()})`);
  }
  return { cutoff: cutoff.toISOString(), expired };
}
