import type { CatalogStorageProvider } from "@/lib/catalog";
import { createLocalCatalogStorage } from "./local";
import { type CatalogStorage, StorageError } from "./types";

export {
  assertCatalogKey,
  catalogStorageKey,
  type CatalogStorage,
  StorageError,
  type StorageErrorCode,
} from "./types";

/**
 * 019 — Almacenamiento del catálogo por proveedor.
 *
 *   getCatalogStorage()                    el de los archivos NUEVOS (hoy `local`)
 *   getCatalogStorage(row.storageProvider) donde vive un archivo ya guardado
 *
 * Fase C añade `azure-blob` (conector opcional, ADR-003) y la selección por
 * `CATALOG_STORAGE`; hasta entonces pedirlo es `misconfigured` (→ 503), nunca
 * un fallo silencioso hacia el disco local.
 */
let local: CatalogStorage | null = null;

export function getCatalogStorage(provider?: CatalogStorageProvider): CatalogStorage {
  const p = provider ?? "local";
  switch (p) {
    case "local":
      local ??= createLocalCatalogStorage();
      return local;
    case "azure-blob":
      throw new StorageError(
        "misconfigured",
        "El almacenamiento Azure Blob no está disponible en esta versión"
      );
  }
}
