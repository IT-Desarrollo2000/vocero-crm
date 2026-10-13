import { apiError } from "@/lib/api";

/**
 * 08 — Errores de dominio del Laboratorio por cliente («Contrato 08-0»). Las
 * rutas los traducen con `labErrorResponse`; nunca un 500 genérico.
 */

/** Lo que aún no implementa 08-A. Las rutas lo traducen a 501. */
export class LabNotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: pendiente (tarea 08-A)`);
    this.name = "LabNotImplementedError";
  }
}

export function labNotImplemented(what: string): never {
  throw new LabNotImplementedError(what);
}

export class LabError extends Error {
  code:
    /** Persona, corrida o caso inexistente o de otra organización. */
    | "not_found"
    /** Sin personas activas para correr (o `personaKeys` vacío). */
    | "no_personas"
    /** Alguna de `personaKeys` no existe, está archivada o inactiva. */
    | "unknown_persona"
    /** `hallazgoIndex` fuera de rango para ese caso. */
    | "hallazgo_not_found"
    /** El hallazgo no trae `sugerencia` (kb) / `ajuste` (profile). */
    | "target_mismatch"
    /** Agregar el texto excede el límite del campo del perfil. */
    | "too_long"
    /** Ya hay una corrida en curso (borrar/editar no aplica: solo correr). */
    | "run_in_progress";

  constructor(code: LabError["code"], message: string) {
    super(message);
    this.name = "LabError";
    this.code = code;
  }
}

export function labErrorStatus(code: LabError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "run_in_progress":
      return 409;
    case "no_personas":
    case "unknown_persona":
    case "hallazgo_not_found":
    case "target_mismatch":
    case "too_long":
      return 422;
  }
}

/** `LabError` → su status; `LabNotImplementedError` → 501; otro → null. */
export function labErrorResponse(err: unknown): Response | null {
  if (err instanceof LabError) {
    return apiError(labErrorStatus(err.code), err.code, err.message);
  }
  if (err instanceof LabNotImplementedError) {
    return apiError(501, "not_implemented", err.message);
  }
  return null;
}
