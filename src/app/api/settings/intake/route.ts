import { withAuth } from "@/lib/api";
import { intakeDisabledResponse, intakeEnabled } from "@/server/intake/flag";
import {
  getIntakeSettingsView,
  revokeIntakeKey,
  rotateIntakeKey,
} from "@/server/intake/settings";

export const dynamic = "force-dynamic";

/**
 * 011 — Ajustes → Leads externos: la clave con la que el ERP entrega sus
 * leads a `POST /api/intake/lead`.
 *
 * Sin la bandera `LEADS_EXTERNOS` esto no existe: 404, no 403.
 */

export const GET = withAuth(async (session) => {
  if (!intakeEnabled()) return intakeDisabledResponse();
  const intake = await getIntakeSettingsView(session.organizationId);
  return Response.json({ intake });
}, { role: "owner" });

/**
 * Genera la clave (o la rota: la vieja deja de valer al instante). La
 * respuesta trae la clave COMPLETA — la única vez que sale del servidor.
 */
export const PUT = withAuth(async (session) => {
  if (!intakeEnabled()) return intakeDisabledResponse();
  const key = await rotateIntakeKey(session.organizationId);
  const intake = await getIntakeSettingsView(session.organizationId);
  return Response.json(
    { key, intake },
    // Que ningún intermediario guarde la respuesta con la clave.
    { headers: { "cache-control": "no-store" } }
  );
}, { role: "owner" });

export const DELETE = withAuth(async (session) => {
  if (!intakeEnabled()) return intakeDisabledResponse();
  await revokeIntakeKey(session.organizationId);
  return Response.json({ ok: true });
}, { role: "owner" });
