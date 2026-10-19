import { parseBody, withAuth } from "@/lib/api";
import { inboxSettingsSchema } from "@/lib/inbox-settings";
import { getInboxSettings, saveInboxSettings } from "@/server/inbox/archive";

export const dynamic = "force-dynamic";

/**
 * 022 — Ajustes de la Bandeja (solo Propietario): auto-archivo de
 * conversaciones inactivas. Sin fila = apagado, 14 días.
 *
 * GET → `{ settings: { autoArchiveEnabled, autoArchiveDays } }`
 */
export const GET = withAuth(async (session) => {
  const settings = await getInboxSettings(session.organizationId);
  return Response.json({ settings });
}, { role: "owner" });

/**
 * PUT `{ autoArchiveEnabled: boolean, autoArchiveDays: 1–365 }`
 *   → 200 `{ settings }` · 422 `invalid_body` fuera de rango
 */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, inboxSettingsSchema);
  if (!body.ok) return body.response;
  const settings = await saveInboxSettings(session.organizationId, body.data);
  return Response.json({ settings });
}, { role: "owner" });
