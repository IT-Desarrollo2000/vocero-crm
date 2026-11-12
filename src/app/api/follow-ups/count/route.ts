import { withAuth } from "@/lib/api";
import { countFollowUps } from "@/server/follow-ups/counts";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/**
 * 035 — El número rojo junto a «Seguimiento» y (fase B) la línea «N
 * recordatorios para hoy (M vencidos)» de la Bandeja: recordatorios PROPIOS
 * (también para el Propietario: es su lista). Una cuenta por índice.
 *
 * GET → 200 `{ overdue, today }` (`today` = abiertos con `due_at` antes del
 *   fin de hoy en la zona del negocio; incluye los vencidos).
 */
export const GET = withAuth(async (session) => {
  const tz = await reportTimezone(session.organizationId);
  const counts = await countFollowUps(session.organizationId, session.userId, new Date(), tz);
  return Response.json(counts);
});
