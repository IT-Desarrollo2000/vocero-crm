import type { CatalogStorageProvider } from "@/lib/catalog";
import {
  createAzureBlobCatalogStorage,
  parseAzureConnectionString,
  resolveAzureBlobConfig,
} from "./azure-blob";
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
 * 019 — Almacenamiento del catálogo por proveedor (ADR-003).
 *
 *   getCatalogStorage()                    el de los archivos NUEVOS (CATALOG_STORAGE)
 *   getCatalogStorage(row.storageProvider) donde vive un archivo ya guardado
 *
 * Cambiar `CATALOG_STORAGE` no migra nada: cada `product_file` recuerda su
 * proveedor, así que lo guardado en `local` se sigue leyendo del disco aunque
 * los nuevos vayan a Azure (y al revés).
 */

/**
 * `CATALOG_STORAGE` se lee de `process.env` directo, como `agendaEnabled()`:
 * preguntar por el proveedor no puede depender de que TODO el entorno valide.
 * Cualquier valor que no sea `azure-blob` es `local` — un typo no manda los
 * archivos a ningún lado raro.
 */
export function parseCatalogStorageProvider(raw: string | undefined): CatalogStorageProvider {
  return (raw ?? "").trim().toLowerCase() === "azure-blob" ? "azure-blob" : "local";
}

export function currentCatalogStorageProvider(): CatalogStorageProvider {
  return parseCatalogStorageProvider(process.env.CATALOG_STORAGE);
}

/** true si el conector Azure está encendido en esta instancia (superficie de Ajustes). */
export function azureCatalogStorageEnabled(): boolean {
  return currentCatalogStorageProvider() === "azure-blob";
}

/** Respuesta de una superficie del conector apagado: no existe en esta instancia. */
export function catalogStorageDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}

let local: CatalogStorage | null = null;
let azure: { signature: string; storage: CatalogStorage } | null = null;

function azureConfig() {
  return {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    container: process.env.AZURE_STORAGE_CONTAINER,
  };
}

function azureStorage(): CatalogStorage {
  const config = azureConfig();
  // Memoizado por config: cambiar las variables (pruebas) crea otro adaptador.
  const signature = `${config.connectionString ?? ""}\u0000${config.container ?? ""}`;
  if (azure?.signature === signature) return azure.storage;
  try {
    resolveAzureBlobConfig(config);
  } catch (err) {
    // UNA línea, al primer uso, con el mensaje saneado (nunca la cadena).
    const msg = err instanceof StorageError ? err.message : "configuración inválida";
    console.error(`[catalog/azure-blob] ${msg}: el catálogo responderá 503 en Azure`);
  }
  azure = { signature, storage: createAzureBlobCatalogStorage(config) };
  return azure.storage;
}

export function getCatalogStorage(provider?: CatalogStorageProvider): CatalogStorage {
  const p = provider ?? currentCatalogStorageProvider();
  switch (p) {
    case "local":
      local ??= createLocalCatalogStorage();
      return local;
    case "azure-blob":
      return azureStorage();
  }
}

/**
 * Lo que Ajustes puede mostrar del conector: cuenta y contenedor, NUNCA la
 * clave ni la cadena. `error` es el motivo saneado si la config no sirve.
 */
export type CatalogStorageView = {
  provider: "azure-blob";
  accountName: string | null;
  container: string | null;
  error: string | null;
};

export function describeAzureCatalogStorage(): CatalogStorageView {
  const config = azureConfig();
  let accountName: string | null = null;
  try {
    accountName = parseAzureConnectionString(config.connectionString).accountName;
  } catch {
    accountName = null;
  }
  let error: string | null = null;
  try {
    resolveAzureBlobConfig(config);
  } catch (err) {
    error = err instanceof StorageError ? err.message : "Configuración inválida";
  }
  return {
    provider: "azure-blob",
    accountName,
    container: config.container?.trim() || null,
    error,
  };
}
