import { apiError, withAuth } from "@/lib/api";
import {
  azureCatalogStorageEnabled,
  catalogStorageDisabledResponse,
  getCatalogStorage,
  StorageError,
} from "@/server/catalog/storage";

export const dynamic = "force-dynamic";

/**
 * 019 — "Probar conexión" del almacenamiento del catálogo. 404 con el
 * conector apagado. El mensaje de error ya viene saneado del adaptador (solo
 * código HTTP y `x-ms-error-code`, nunca la clave ni la URL firmada).
 */
export const POST = withAuth(async () => {
  if (!azureCatalogStorageEnabled()) return catalogStorageDisabledResponse();
  try {
    await getCatalogStorage("azure-blob").test();
  } catch (err) {
    if (err instanceof StorageError && err.code === "misconfigured") {
      return apiError(422, "storage_misconfigured", err.message);
    }
    if (err instanceof StorageError) {
      return apiError(503, "storage_unavailable", err.message);
    }
    console.error("[catalog-storage/test] error inesperado");
    return apiError(503, "storage_unavailable", "No se pudo probar el almacenamiento");
  }
  return Response.json({ ok: true });
}, { role: "owner" });
