import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getCatalogStorage, StorageError } from "./storage";

/**
 * 019 — Lectura de un archivo del catálogo para el envío (FR-940).
 *
 * Fila y bytes van por separado para que el envío en lote pueda comprobar
 * TODAS las filas antes de mandar nada y leer los bytes de uno en uno (un
 * lote de 10 archivos no se carga entero en memoria). `readCatalogFile`
 * compone las dos.
 *
 * Los fallos del almacenamiento salen como `CatalogFileError` con los códigos
 * de FR-941 (`file_missing`, `storage_unavailable`); el mensaje es el ya
 * saneado de `StorageError`.
 */

export type CatalogFileRow = typeof schema.productFile.$inferSelect;

export type CatalogFileErrorCode = "file_missing" | "storage_unavailable";

export class CatalogFileError extends Error {
  code: CatalogFileErrorCode;
  constructor(code: CatalogFileErrorCode, message: string) {
    super(message);
    this.name = "CatalogFileError";
    this.code = code;
  }
}

/** Fila de `product_file` de la organización; null si no existe en ella. */
export async function getCatalogFileRow(
  organizationId: string,
  fileId: string
): Promise<CatalogFileRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.productFile)
    .where(
      scoped(
        schema.productFile.organizationId,
        organizationId,
        eq(schema.productFile.id, fileId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Bytes de un archivo ya resuelto, del proveedor donde se guardó (FR-912). */
export async function readCatalogFileData(row: CatalogFileRow): Promise<Buffer> {
  try {
    return await getCatalogStorage(row.storageProvider).get(row.storageKey);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new CatalogFileError(
        err.code === "not_found" ? "file_missing" : "storage_unavailable",
        err.message
      );
    }
    throw err;
  }
}

/** Fila + bytes; null si el archivo no existe en la organización. */
export async function readCatalogFile(
  organizationId: string,
  fileId: string
): Promise<{ row: CatalogFileRow; data: Buffer } | null> {
  const row = await getCatalogFileRow(organizationId, fileId);
  if (!row) return null;
  return { row, data: await readCatalogFileData(row) };
}
