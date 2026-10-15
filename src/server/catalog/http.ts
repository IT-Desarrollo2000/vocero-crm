import { apiError } from "@/lib/api";
import { CatalogError } from "./store";

/**
 * 019 — Traducción común de las rutas `/api/catalog/*`: `CatalogError` →
 * `{ error: { code, message } }` con su status; cualquier otro error se
 * relanza (lo captura `withAuth` como 500 sin stack).
 */
export function catalogErrorResponse(err: unknown): Response {
  if (err instanceof CatalogError) return apiError(err.status, err.code, err.message);
  throw err;
}

/** Ids de ruta: mismo criterio que `/api/media/[assetId]`. */
const ID_PATTERN = /^[\w.-]{1,64}$/;

/** 404 para un id con forma imposible (no se consulta la BD). */
export function invalidId(id: string, message: string): Response | null {
  return ID_PATTERN.test(id) ? null : apiError(404, "not_found", message);
}
