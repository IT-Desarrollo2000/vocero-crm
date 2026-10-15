import { withAuth } from "@/lib/api";
import {
  azureCatalogStorageEnabled,
  catalogStorageDisabledResponse,
  describeAzureCatalogStorage,
} from "@/server/catalog/storage";

export const dynamic = "force-dynamic";

/**
 * 019 — Estado del almacenamiento del catálogo (ADR-003, FR-913).
 *
 * Solo existe con `CATALOG_STORAGE=azure-blob`: con el disco local no hay
 * nada que configurar y la ruta responde 404. Devuelve la cuenta y el
 * contenedor; NUNCA la clave ni la cadena de conexión.
 */
export const GET = withAuth(async () => {
  if (!azureCatalogStorageEnabled()) return catalogStorageDisabledResponse();
  return Response.json(describeAzureCatalogStorage());
}, { role: "owner" });
