/**
 * 011 — Si esta instancia recibe leads externos (formulario web del negocio,
 * FastApp de sus promotores) por `POST /api/intake/lead`.
 *
 * Mismo trato que la atribución (016) y los canales opcionales (ADR-001): el
 * código viaja siempre en `main` y lo que decide si EXISTE para el usuario es
 * una variable de despliegue, apagada por defecto. Apagada, el endpoint y la
 * pestaña de Ajustes responden 404 y nada en la UI la menciona.
 *
 * La migración (`intake_settings`) se aplica siempre: una tabla vacía es
 * inerte, y a cambio todas las instancias comparten la misma estructura.
 */

/** Valores que cuentan como "encendida". Cualquier otra cosa, apagada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseIntakeFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Se lee de `process.env` directo, no por `getEnv()`, igual que
 * `atribucionEnabled()`: preguntar si una feature existe no puede depender de
 * que TODO el entorno valide. `LEADS_EXTERNOS` sí está declarada en
 * `lib/env.ts`, donde viven su documentación y su tipo.
 */
export function intakeEnabled(): boolean {
  return parseIntakeFlag(process.env.LEADS_EXTERNOS);
}

/**
 * Respuesta para una superficie apagada. 404 y no 403 a propósito: si la
 * bandera está apagada, ese endpoint no existe en esta instancia.
 */
export function intakeDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
