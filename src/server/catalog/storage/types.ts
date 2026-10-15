import type { CatalogStorageProvider } from "@/lib/catalog";

/**
 * 019 — Contrato del almacenamiento del catálogo (FR-910, ADR-003).
 *
 * El núcleo guarda en disco local (`local`, default). `azure-blob` es un
 * CONECTOR opcional (fase C) detrás de `CATALOG_STORAGE`: implementa este
 * mismo contrato y corre la misma suite (`tests/unit/catalog-storage.test.ts`,
 * `runStorageContract`). Cada `product_file` recuerda su proveedor y su clave
 * (FR-912), así que se lee y borra donde se guardó.
 *
 * Toda falla sale como `StorageError` con un mensaje SANEADO (sin cadenas de
 * conexión, llaves ni rutas absolutas del servidor): llega a la UI y a logs.
 */
export interface CatalogStorage {
  provider: CatalogStorageProvider;
  /** Guarda (o reemplaza) los bytes de `key`. */
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  /** Bytes de `key`; `StorageError("not_found")` si no existen. */
  get(key: string): Promise<Buffer>;
  /** Idempotente: borrar algo que no existe no es error. */
  delete(key: string): Promise<void>;
  /** "Probar conexión": resuelve si el proveedor acepta escribir. */
  test(): Promise<void>;
}

export type StorageErrorCode = "unavailable" | "not_found" | "misconfigured";

export class StorageError extends Error {
  code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Segmento de clave: mismo criterio que `assertSafeSegment` de whatsapp/media.ts, sin `.`/`..`. */
const SAFE_SEGMENT = /^[\w.-]+$/;

function isSafeSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s) && s !== "." && s !== "..";
}

/** Forma única de una clave del catálogo: `{org}/catalog/{fileId}`. */
const KEY_PATTERN = /^([^/]+)\/catalog\/([^/]+)$/;

/**
 * Valida una clave antes de tocar el proveedor (lo hace CADA implementación:
 * una clave leída de BD tampoco se da por buena). Lanza `misconfigured`.
 */
export function assertCatalogKey(key: string): void {
  const m = KEY_PATTERN.exec(key);
  if (!m || !isSafeSegment(m[1]!) || !isSafeSegment(m[2]!)) {
    throw new StorageError("misconfigured", "Clave de almacenamiento inválida");
  }
}

/** Clave de un archivo del catálogo; siempre con el prefijo de la org (FR-910). */
export function catalogStorageKey(organizationId: string, fileId: string): string {
  const key = `${organizationId}/catalog/${fileId}`;
  assertCatalogKey(key);
  return key;
}
