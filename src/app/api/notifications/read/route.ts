import { parseBody, withAuth } from "@/lib/api";
import { notificationReadSchema } from "@/lib/notifications";
import { markNotificationsRead } from "@/server/notifications/store";

export const dynamic = "force-dynamic";

/**
 * 035 B — Marcar avisos como leídos (solo los PROPIOS: un id ajeno no cambia
 * nada, sin distinguir).
 *
 * POST `{ ids: string[] }` · `{ all: true }` → 200 `{ updated }` · 422
 *   `invalid_body`. Publica `notification.changed { reason: "read" }` a las
 *   demás pestañas de quien pide.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, notificationReadSchema);
  if (!body.ok) return body.response;
  const updated = await markNotificationsRead(session.organizationId, session.userId, body.data);
  return Response.json({ updated });
});
