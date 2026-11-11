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
 *
 * 034: el mismo almacenamiento guarda el material de capacitación de la Ayuda
 * (`training_asset`) en su propio espacio de nombres de la clave, y el
 * contrato suma `stat`/`getRange` para servir video por rangos (`Range` → 206).
 */
export interface CatalogStorage {
  provider: CatalogStorageProvider;
  /** Guarda (o reemplaza) los bytes de `key`. */
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  /** Bytes de `key`; `StorageError("not_found")` si no existen. */
  get(key: string): Promise<Buffer>;
  /** Tamaño en bytes de `key`; `StorageError("not_found")` si no existe. */
  stat(key: string): Promise<{ size: number }>;
  /**
   * Bytes `start..end`, AMBOS inclusive (como `Range: bytes=start-end`). Quien
   * llama ya validó el rango contra `stat`: `0 ≤ start ≤ end < size`.
   * `StorageError("not_found")` si no existe.
   */
  getRange(key: string, start: number, end: number): Promise<Buffer>;
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

/**
 * Espacios de nombres de la clave: `catalog` (019, `product_file`) y
 * `capacitacion` (034, `training_asset`). Cualquier otro se rechaza.
 */
export const STORAGE_NAMESPACES = ["catalog", "capacitacion"] as const;
export type StorageNamespace = (typeof STORAGE_NAMESPACES)[number];

/** Forma única de una clave: `{org}/{espacio}/{id}`. */
const KEY_PATTERN = /^([^/]+)\/(catalog|capacitacion)\/([^/]+)$/;

/**
 * Valida una clave antes de tocar el proveedor (lo hace CADA implementación:
 * una clave leída de BD tampoco se da por buena). Lanza `misconfigured`.
 */
export function assertStorageKey(key: string): void {
  const m = KEY_PATTERN.exec(key);
  if (!m || !isSafeSegment(m[1]!) || !isSafeSegment(m[3]!)) {
    throw new StorageError("misconfigured", "Clave de almacenamiento inválida");
  }
}

/** Nombre de 019: valida claves de CUALQUIER espacio (ver `assertStorageKey`). */
export const assertCatalogKey = assertStorageKey;

/** Clave de un archivo de un espacio; siempre con el prefijo de la org (FR-910). */
export function storageKey(
  organizationId: string,
  namespace: StorageNamespace,
  id: string
): string {
  const key = `${organizationId}/${namespace}/${id}`;
  assertStorageKey(key);
  return key;
}

/** Clave de un archivo del catálogo: `{org}/catalog/{fileId}`. */
export function catalogStorageKey(organizationId: string, fileId: string): string {
  return storageKey(organizationId, "catalog", fileId);
}

/** 034 — Clave de un material de capacitación: `{org}/capacitacion/{assetId}`. */
export function trainingStorageKey(organizationId: string, assetId: string): string {
  return storageKey(organizationId, "capacitacion", assetId);
}
