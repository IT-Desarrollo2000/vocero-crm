import { apiError } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveInstanceOrg } from "@/server/bot/auth";
import { intakeDisabledResponse, intakeEnabled } from "./flag";
import { verifyIntakeKey } from "./settings";

/**
 * 011 (RF-1, RF-2) — Autenticación de `POST /api/intake/lead`.
 *
 * Esta superficie la consume el ERP del negocio (trigger + `pg_net`), no un
 * navegador. Orden: bandera (apagada → 404) → límite de tasa GLOBAL → la
 * organización de la instancia → `X-API-Key` contra la clave cifrada en
 * `intake_settings`, en tiempo constante. Sin clave configurada o incorrecta,
 * 401 sin detalle.
 *
 * Solo límite global, sin límite por IP: todo llega desde la IP de salida de
 * Supabase, y uno por IP más estricto frenaría leads legítimos. El antispam
 * del visitante vive en el ERP (reCAPTCHA y 5/h por IP en el formulario).
 */

export const INTAKE_RATE_LIMIT = { windowMs: 60_000, max: 120 };

export async function requireIntakeKey(
  req: Request
): Promise<
  { ok: true; organizationId: string } | { ok: false; response: Response }
> {
  if (!intakeEnabled()) return { ok: false, response: intakeDisabledResponse() };

  const rl = checkRateLimit("intake-api", INTAKE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      ok: false,
      response: apiError(429, "rate_limited", "Demasiadas solicitudes"),
    };
  }

  const unauthorized = {
    ok: false as const,
    response: apiError(401, "unauthorized", "No autorizado"),
  };
  const provided = req.headers.get("x-api-key");
  if (!provided) return unauthorized;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) return unauthorized;
  if (!(await verifyIntakeKey(organizationId, provided))) return unauthorized;
  return { ok: true, organizationId };
}
