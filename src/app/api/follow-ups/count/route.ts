import { withAuth } from "@/lib/api";
import { countOverdue } from "@/server/follow-ups/store";

export const dynamic = "force-dynamic";

/**
 * 035 — El número rojo junto a «Seguimiento»: recordatorios PROPIOS vencidos
 * (también para el Propietario: es su lista). Una cuenta por índice.
 *
 * GET → 200 `{ overdue: number }`.
 */
export const GET = withAuth(async (session) => {
  const overdue = await countOverdue(session.organizationId, session.userId);
  return Response.json({ overdue });
});
