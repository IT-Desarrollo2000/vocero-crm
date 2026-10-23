import { parseBody, withAuth } from "@/lib/api";
import { inboxSettingsSchema } from "@/lib/inbox-settings";
import { getInboxSettings, saveInboxSettings } from "@/server/inbox/archive";

export const dynamic = "force-dynamic";

/**
 * 022 — Ajustes de la Bandeja (solo Propietario): auto-archivo de
 * conversaciones inactivas. Sin fila = apagado, 14 días.
 *
 * GET → `{ settings: { autoArchiveEnabled, autoArchiveDays, overdueMinutes,
 *   sellersCreateQuickReplies } }` (026: `overdueMinutes` = umbral de
 * "atrasada" de Por atender; sin fila, 60. 029: `sellersCreateQuickReplies` =
 * los Vendedores crean respuestas rápidas; sin fila, true).
 */
export const GET = withAuth(async (session) => {
  const settings = await getInboxSettings(session.organizationId);
  return Response.json({ settings });
}, { role: "owner" });

/**
 * PUT parcial (029) `{ autoArchiveEnabled?: boolean, autoArchiveDays?: 1–365,
 *       overdueMinutes?: 5–1440, sellersCreateQuickReplies?: boolean }`
 *   (al menos uno; lo ausente se conserva) → 200 `{ settings }` completos
 *   · 422 `invalid_body` fuera de rango o vacío
 */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, inboxSettingsSchema);
  if (!body.ok) return body.response;
  const settings = await saveInboxSettings(session.organizationId, body.data);
  return Response.json({ settings });
}, { role: "owner" });
