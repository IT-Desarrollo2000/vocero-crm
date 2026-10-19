import { apiError } from "@/lib/api";
import { checkRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { resolveInstanceOrg } from "@/server/bot/auth";
import { intakeDisabledResponse, intakeEnabled } from "./flag";
import { verifyIntakeKey } from "./settings";

/**
 * 011 (RF-1, RF-2) — Autenticación de `POST /api/intake/lead`.
 *
 * Esta superficie la consume el ERP del negocio (trigger + `pg_net`), no un
 * navegador. Orden:
 *
 *  1. bandera (apagada → 404);
 *  2. ¿la IP agotó su cupo de FALLOS? → 429 sin detalle;
 *  3. la organización de la instancia + `X-API-Key` contra la clave cifrada en
 *     `intake_settings`, en tiempo constante. Sin clave, sin organización o
 *     clave incorrecta → cuenta en la cubeta de fallos de la IP y 401 sin
 *     detalle;
 *  4. límite GLOBAL, solo para peticiones ya autenticadas → 429.
 *
 * Así, alguien sin clave no puede agotar el cupo global y dejar al ERP en
 * 429: sus intentos solo llenan la cubeta de SU IP. Esa cubeta cuenta solo
 * fallos, así que el ERP (todo llega desde la IP de salida de Supabase) no la
 * llena mientras use la clave correcta. El antispam del visitante vive en el
 * ERP (reCAPTCHA y 5/h por IP en el formulario).
 */

/** Peticiones autenticadas, de cualquier origen. */
export const INTAKE_RATE_LIMIT = { windowMs: 60_000, max: 120 };
/** Intentos fallidos (sin clave o clave incorrecta) por IP. */
export const INTAKE_FAIL_RATE_LIMIT = { windowMs: 60_000, max: 20 };

/** La IP del cliente, como en el limitador del login (`lib/auth`). */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

const rateLimited = () => ({
  ok: false as const,
  response: apiError(429, "rate_limited", "Demasiadas solicitudes"),
});

export async function requireIntakeKey(
  req: Request
): Promise<
  { ok: true; organizationId: string } | { ok: false; response: Response }
> {
  if (!intakeEnabled()) return { ok: false, response: intakeDisabledResponse() };

  const failKey = `intake-fail:${clientIp(req)}`;
  if (!peekRateLimit(failKey, INTAKE_FAIL_RATE_LIMIT).allowed) {
    return rateLimited();
  }

  const unauthorized = () => {
    checkRateLimit(failKey, INTAKE_FAIL_RATE_LIMIT); // solo registra el fallo
    return {
      ok: false as const,
      response: apiError(401, "unauthorized", "No autorizado"),
    };
  };
  const provided = req.headers.get("x-api-key");
  if (!provided) return unauthorized();
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) return unauthorized();
  if (!(await verifyIntakeKey(organizationId, provided))) return unauthorized();

  if (!checkRateLimit("intake-api", INTAKE_RATE_LIMIT).allowed) {
    return rateLimited();
  }
  return { ok: true, organizationId };
}
