import { desc, eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { FichaEventDto, FichaHistoryResponse } from "@/lib/types";
import { getContactById } from "@/server/contacts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Cuántos eventos devuelve el panel: los más recientes. */
const LIMIT = 50;

/**
 * 04 — Bitácora de la ficha del contacto (`ficha_event`), ambos roles.
 * Contrato 04-0 (dev-tasks/04-el-agente-llena-la-ficha.md).
 *
 * GET → 200 `FichaHistoryResponse` (últimos 50, más reciente primero) · 404
 * `not_found` si el contacto no es de la organización.
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");

  const rows = await getDb()
    .select({
      event: schema.fichaEvent,
      actorName: schema.user.name,
    })
    .from(schema.fichaEvent)
    .leftJoin(schema.user, eq(schema.fichaEvent.actorUserId, schema.user.id))
    .where(
      scoped(
        schema.fichaEvent.organizationId,
        session.organizationId,
        eq(schema.fichaEvent.contactId, id)
      )
    )
    .orderBy(desc(schema.fichaEvent.createdAt), desc(schema.fichaEvent.id))
    .limit(LIMIT);

  const events: FichaEventDto[] = rows.map(({ event: e, actorName }) => ({
    id: e.id,
    key: e.key,
    oldValue: e.oldValue ?? null,
    newValue: e.newValue ?? null,
    source: e.source,
    outcome: e.outcome,
    reason: e.reason ?? null,
    actor:
      e.actorUserId && actorName !== null
        ? { id: e.actorUserId, name: actorName }
        : null,
    conversationId: e.conversationId,
    createdAt: e.createdAt.toISOString(),
  }));
  const body: FichaHistoryResponse = { events };
  return Response.json(body);
});
