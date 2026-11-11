import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  TRAINING_LIMITS,
  TRAINING_RULES,
  type TrainingAssetDto,
  type TrainingKind,
  type TrainingPatchBody,
  type TrainingReorderBody,
  type TrainingUploadFields,
} from "@/lib/training";
import { inspectFile } from "@/server/media/file-policy";
import {
  getCatalogStorage,
  StorageError,
  trainingStorageKey,
  type CatalogStorage,
} from "@/server/catalog/storage";
import { serializeTrainingAsset, type TrainingAssetRow } from "./dto";

/**
 * 034 — Persistencia del material de capacitación de la Ayuda. Mismo camino
 * que los archivos del catálogo (`addProductFile`): tipo por FIRMA →
 * `put` → fila, y si la fila falla se borra el blob recién escrito. Toda
 * query pasa por `scoped(…)`; todo error esperable sale como `TrainingError`:
 *
 *   404 not_found           el material no es de la org
 *   409 too_many            ya hay `maxPerKind` de ese tipo
 *   409 conflict            otra subida ganó la imagen del mismo tema
 *   410 file_missing        la fila existe pero sus bytes no (al servir)
 *   413 too_large           pasa del tope de su tipo
 *   415 unsupported_type    la firma no es la del tipo (p. ej. PNG «.mp4»)
 *   422 invalid_replace     `replaceId` de otro tipo
 *   422 invalid_topic       tema en un material que no lo admite
 *   422 invalid_order       el orden no trae exactamente los de ese tipo
 *   503 storage_unavailable el proveedor no responde o está mal configurado
 *
 * Los bytes se leen y borran donde se guardó cada fila (`storage_provider`,
 * ADR-003). Borrar es best-effort DESPUÉS del DELETE, como en el catálogo.
 */

export type TrainingErrorCode =
  | "not_found"
  | "too_many"
  | "conflict"
  | "file_missing"
  | "too_large"
  | "unsupported_type"
  | "invalid_replace"
  | "invalid_topic"
  | "invalid_order"
  | "storage_unavailable";

const DEFAULT_MESSAGE: Record<TrainingErrorCode, string> = {
  not_found: "Material no encontrado",
  too_many: `Caben hasta ${TRAINING_LIMITS.maxPerKind} de cada tipo`,
  conflict: "Otra subida acaba de cambiar esa imagen: vuelve a intentarlo",
  file_missing: "El archivo ya no está en el almacenamiento",
  too_large: "El archivo es demasiado grande",
  unsupported_type: "Tipo de archivo no permitido",
  invalid_replace: "Solo se puede reemplazar por un archivo del mismo tipo",
  invalid_topic: "Este material no va en un tema de la Ayuda",
  invalid_order: "El orden tiene que traer todos los de ese tipo, una vez cada uno",
  storage_unavailable: "El almacenamiento no está disponible",
};

/** Por qué se rechaza un archivo que no es de su tipo (se le muestra al usuario). */
const WRONG_TYPE: Record<TrainingKind, string> = {
  document: "El archivo no es un PDF",
  video: "El archivo no es un video MP4",
  help_image: "El archivo no es una imagen PNG, JPG o WebP",
};

const TOO_LARGE: Record<TrainingKind, string> = {
  document: "El PDF pasa de 25 MB",
  video: "El video pasa de 100 MB",
  help_image: "La imagen pasa de 5 MB",
};

export class TrainingError extends Error {
  constructor(
    readonly status: number,
    readonly code: TrainingErrorCode,
    message?: string
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "TrainingError";
  }
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;

const t = schema.trainingAsset;

function assetsWhere(organizationId: string, ...conds: Parameters<typeof scoped>[2][]) {
  return scoped(t.organizationId, organizationId, ...conds);
}

function storageError(err: unknown): TrainingError {
  if (err instanceof StorageError) {
    return new TrainingError(503, "storage_unavailable", err.message);
  }
  if (err instanceof TrainingError) return err;
  console.error("[training] error inesperado del almacenamiento");
  return new TrainingError(503, "storage_unavailable");
}

function storageFor(provider?: TrainingAssetRow["storageProvider"]): CatalogStorage {
  try {
    return getCatalogStorage(provider);
  } catch (err) {
    throw storageError(err);
  }
}

/** Best-effort: la fila ya no existe; un fallo se registra sin claves ni rutas. */
async function removeBlob(
  row: Pick<TrainingAssetRow, "id" | "storageProvider" | "storageKey">
): Promise<void> {
  try {
    await getCatalogStorage(row.storageProvider).delete(row.storageKey);
  } catch (err) {
    const code = err instanceof StorageError ? err.code : "error";
    console.error(
      `[training] no se pudo borrar el binario de ${row.id} (${row.storageProvider}): ${code}`
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function getRow(q: Q, organizationId: string, id: string): Promise<TrainingAssetRow | null> {
  const rows = await q.select().from(t).where(assetsWhere(organizationId, eq(t.id, id))).limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

/** Todo el material de la org: documentos, videos e imágenes, cada uno en su orden. */
export async function listTrainingAssets(organizationId: string): Promise<TrainingAssetDto[]> {
  const rows = await getDb()
    .select()
    .from(t)
    .where(assetsWhere(organizationId))
    .orderBy(asc(t.kind), asc(t.position), asc(t.createdAt), asc(t.id));
  return rows.map(serializeTrainingAsset);
}

/* ------------------------------------------------------------------ *
 * Alta / reemplazo
 * ------------------------------------------------------------------ */

export type AddTrainingAssetInput = {
  data: Buffer;
  fileName: string;
  /** MIME que declaró el navegador: solo pista, decide la firma. */
  declaredMime?: string;
  fields: TrainingUploadFields;
};

/** Título por defecto: el nombre del archivo sin extensión ni rutas. */
export function titleFromFileName(raw: string | null | undefined, kind: TrainingKind): string {
  const base = (raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[_]+/g, " ")
    .trim()
    .slice(0, TRAINING_LIMITS.titleMax);
  if (base) return base;
  return kind === "document" ? "Documento" : kind === "video" ? "Video" : "Imagen";
}

/**
 * Sube un material (H1). Orden: tope y firma (sin tocar nada) → fila a
 * reemplazar → `put` → en UNA transacción, borrar la vieja e insertar la
 * nueva → borrar los bytes viejos. Si falla la transacción se borra el blob
 * nuevo; si falla el `put` no se escribe nada en BD.
 *
 * Una imagen de tema que ya existe se reemplaza sola («Cambiar»), aunque no
 * venga `replaceId`.
 */
export async function addTrainingAsset(
  organizationId: string,
  input: AddTrainingAssetInput
): Promise<TrainingAssetDto> {
  const { fields } = input;
  const kind = fields.kind;
  const rule = TRAINING_RULES[kind];
  if (input.data.byteLength > rule.maxBytes) {
    throw new TrainingError(413, "too_large", TOO_LARGE[kind]);
  }
  const inspection = inspectFile(input.data, {
    fileName: input.fileName,
    mime: input.declaredMime ?? null,
  });
  if (!inspection.ok) throw new TrainingError(415, "unsupported_type", inspection.reason);
  if (!rule.mimes.includes(inspection.mime)) {
    throw new TrainingError(415, "unsupported_type", WRONG_TYPE[kind]);
  }

  const db = getDb();
  let replaced: TrainingAssetRow | null = null;
  if (fields.replaceId) {
    replaced = await getRow(db, organizationId, fields.replaceId);
    if (!replaced) throw new TrainingError(404, "not_found");
    if (replaced.kind !== kind) throw new TrainingError(422, "invalid_replace");
  }
  const topicId =
    kind === "document" ? null : (fields.topicId ?? replaced?.topicId ?? null);
  if (kind === "help_image" && !topicId) {
    throw new TrainingError(422, "invalid_topic", "Una imagen de la Ayuda necesita su tema");
  }
  if (kind === "help_image" && !replaced) {
    const rows = await db
      .select()
      .from(t)
      .where(assetsWhere(organizationId, eq(t.kind, "help_image"), eq(t.topicId, topicId!)))
      .limit(1);
    replaced = rows[0] ?? null;
  }
  if (!replaced) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(t)
      .where(assetsWhere(organizationId, eq(t.kind, kind)));
    if (n >= TRAINING_LIMITS.maxPerKind) throw new TrainingError(409, "too_many");
  }

  const id = newId("trainingAsset");
  const storage = storageFor();
  const storageKey = trainingStorageKey(organizationId, id);
  try {
    await storage.put(storageKey, input.data, inspection.mime);
  } catch (err) {
    throw storageError(err);
  }

  let created: TrainingAssetRow;
  try {
    created = await db.transaction(async (tx) => {
      if (replaced) {
        await tx.delete(t).where(assetsWhere(organizationId, eq(t.id, replaced.id)));
      }
      const rows = await tx
        .insert(t)
        .values({
          id,
          organizationId,
          kind,
          title: fields.title ?? replaced?.title ?? titleFromFileName(input.fileName, kind),
          topicId,
          position:
            replaced?.position ??
            sql`(select coalesce(max(${t.position}), -1) + 1 from ${t} where ${t.organizationId} = ${organizationId} and ${t.kind} = ${kind})`,
          storageProvider: storage.provider,
          storageKey,
          mimeType: inspection.mime,
          sizeBytes: input.data.byteLength,
          durationSeconds: kind === "video" ? (fields.durationSeconds ?? null) : null,
          width: kind === "help_image" ? (fields.width ?? null) : null,
          height: kind === "help_image" ? (fields.height ?? null) : null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert de training_asset sin fila");
      return row;
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => {
      console.error(`[training] no se pudo limpiar el binario huérfano de ${id}`);
    });
    if (isUniqueViolation(err)) throw new TrainingError(409, "conflict");
    throw err;
  }
  if (replaced) await removeBlob(replaced);
  return serializeTrainingAsset(created);
}

/* ------------------------------------------------------------------ *
 * Editar, reordenar, quitar
 * ------------------------------------------------------------------ */

/** Nombre del botón / título del video, y el tema de un video. */
export async function updateTrainingAsset(
  organizationId: string,
  id: string,
  patch: TrainingPatchBody
): Promise<TrainingAssetDto> {
  const db = getDb();
  const row = await getRow(db, organizationId, id);
  if (!row) throw new TrainingError(404, "not_found");
  // El tema de una imagen ES su lugar (se cambia subiendo otra); un
  // documento no tiene tema.
  if (patch.topicId !== undefined && row.kind !== "video") {
    throw new TrainingError(422, "invalid_topic");
  }
  const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.topicId !== undefined) set.topicId = patch.topicId;
  const rows = await db
    .update(t)
    .set(set)
    .where(assetsWhere(organizationId, eq(t.id, id)))
    .returning();
  const updated = rows[0];
  if (!updated) throw new TrainingError(404, "not_found");
  return serializeTrainingAsset(updated);
}

/** El orden completo de los documentos o de los videos (↑/↓ de Ajustes). */
export async function reorderTrainingAssets(
  organizationId: string,
  body: TrainingReorderBody
): Promise<TrainingAssetDto[]> {
  await getDb().transaction(async (tx) => {
    const current = await tx
      .select({ id: t.id })
      .from(t)
      .where(assetsWhere(organizationId, eq(t.kind, body.kind)));
    const have = new Set(current.map((r) => r.id));
    if (have.size !== body.ids.length || body.ids.some((x) => !have.has(x))) {
      throw new TrainingError(422, "invalid_order");
    }
    const now = new Date();
    for (const [position, assetId] of body.ids.entries()) {
      await tx
        .update(t)
        .set({ position, updatedAt: now })
        .where(assetsWhere(organizationId, eq(t.id, assetId), inArray(t.kind, [body.kind])));
    }
  });
  return listTrainingAssets(organizationId);
}

export async function deleteTrainingAsset(organizationId: string, id: string): Promise<void> {
  const rows = await getDb()
    .delete(t)
    .where(assetsWhere(organizationId, eq(t.id, id)))
    .returning({ id: t.id, storageProvider: t.storageProvider, storageKey: t.storageKey });
  const row = rows[0];
  if (!row) throw new TrainingError(404, "not_found");
  await removeBlob(row);
}

/* ------------------------------------------------------------------ *
 * Servir (GET /api/training/[id]/file)
 * ------------------------------------------------------------------ */

export type TrainingFileHandle = {
  row: TrainingAssetRow;
  size: number;
  /** Bytes `start..end` inclusive (ya validados contra `size`). */
  read(start: number, end: number): Promise<Buffer>;
  /** El archivo entero (200 sin `Range`). */
  readAll(): Promise<Buffer>;
};

function readError(row: TrainingAssetRow, err: unknown): TrainingError {
  if (err instanceof StorageError && err.code === "not_found") {
    console.error(`[training] ${row.id} sin binario en ${row.storageProvider}`);
    return new TrainingError(410, "file_missing");
  }
  return storageError(err);
}

/**
 * La fila y un lector de sus bytes donde se guardaron. null si no es de la
 * org. Fila sin bytes → 410 `file_missing`; proveedor caído → 503.
 */
export async function openTrainingFile(
  organizationId: string,
  id: string
): Promise<TrainingFileHandle | null> {
  const row = await getRow(getDb(), organizationId, id);
  if (!row) return null;
  const storage = storageFor(row.storageProvider);
  let size: number;
  try {
    size = (await storage.stat(row.storageKey)).size;
  } catch (err) {
    throw readError(row, err);
  }
  return {
    row,
    size,
    async read(start, end) {
      try {
        return await storage.getRange(row.storageKey, start, end);
      } catch (err) {
        throw readError(row, err);
      }
    },
    async readAll() {
      try {
        return await storage.get(row.storageKey);
      } catch (err) {
        throw readError(row, err);
      }
    },
  };
}
