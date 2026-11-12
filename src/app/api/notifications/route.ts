import { withAuth } from "@/lib/api";
import { listNotifications } from "@/server/notifications/store";

export const dynamic = "force-dynamic";

/**
 * 035 B — La campana de QUIEN PIDE (también el Propietario: solo los suyos).
 *
 * GET → 200 `NotificationListDto`: los últimos 30 (el más reciente primero)
 *   con el estado vivo de cada recordatorio (abierto / hecho / pospuesto),
 *   `unread` y `summary` `{ today, overdue }` (el texto vivo del resumen del
 *   día) en la zona del negocio.
 */
export const GET = withAuth(async (session) => {
  return Response.json(await listNotifications(session.organizationId, session.userId));
});
