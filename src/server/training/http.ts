import { apiError } from "@/lib/api";
import { TrainingError } from "./store";

/**
 * 034 — Traducción común de `/api/training/*`: `TrainingError` →
 * `{ error: { code, message } }` con su status; cualquier otro error se
 * relanza (lo captura `withAuth` como 500 sin stack). Mismo criterio que
 * `src/server/catalog/http.ts`.
 */
export function trainingErrorResponse(err: unknown): Response {
  if (err instanceof TrainingError) return apiError(err.status, err.code, err.message);
  throw err;
}

/** Ids de ruta: mismo criterio que `/api/catalog/files/[id]`. */
const ID_PATTERN = /^[\w.-]{1,64}$/;

/** 404 para un id con forma imposible (no se consulta la BD). */
export function invalidTrainingId(id: string): Response | null {
  return ID_PATTERN.test(id) ? null : apiError(404, "not_found", "Material no encontrado");
}
