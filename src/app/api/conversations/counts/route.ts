import { apiError, withAuth } from "@/lib/api";
import { parseAssigned, parseInboxQuery } from "@/server/inbox/list-query";
import { countConversations } from "@/server/inbox/queries";
import type { ConversationCounts } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * 06: contadores de la Bandeja (`ConversationCounts` de `src/lib/types.ts`)
 * con los MISMOS filtros que la lista, siempre dentro de lo visible para quien
 * pide. Ignora `limit` y `cursor`. `assigned` inválido → 422
 * `invalid_query` (igual que la lista).
 *
 * 020: también recibe la vista (`filter`) y los filtros del panel (`origin`,
 * `unassigned`, `closing`): los contadores son FACETADOS — cada uno dice lo
 * que verías al elegir esa opción dejando lo demás fijo (ver
 * `countConversations`).
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const assigned = parseAssigned(url.searchParams.get("assigned"));
  if (!assigned) {
    return apiError(
      422,
      "invalid_query",
      "assigned debe ser me, unassigned, others o all"
    );
  }
  const { q, stageId, channel, filter, origin, mine, unassigned, closing } = parseInboxQuery(
    url.searchParams
  );
  const counts: ConversationCounts = await countConversations(
    session.organizationId,
    session,
    { q, stageId, channel, assigned, filter, origin, mine, unassigned, closing }
  );
  return Response.json(counts);
});
