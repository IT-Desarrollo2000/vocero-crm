import { apiError, withAuth } from "@/lib/api";
import { parseAssigned, parseInboxQuery } from "@/server/inbox/list-query";
import { countConversations } from "@/server/inbox/queries";
import type { ConversationCounts } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * 06: contadores de la Bandeja (`ConversationCounts` de `src/lib/types.ts`)
 * con los MISMOS filtros que la lista (`q`, `stage`, `channel`, `assigned`),
 * siempre dentro de lo visible para quien pide. Ignora `filter`, `limit` y
 * `cursor`. Capas y `teamMode`: ver dev-tasks/06-paginacion-de-la-bandeja.md,
 * "Contrato 06-0". `assigned` inválido → 422 `invalid_query` (igual que la
 * lista).
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const assigned = parseAssigned(url.searchParams.get("assigned"));
  if (!assigned) {
    return apiError(
      422,
      "invalid_query",
      "assigned debe ser me, unassigned o all"
    );
  }
  const { q, stageId, channel } = parseInboxQuery(url.searchParams);
  const counts: ConversationCounts = await countConversations(
    session.organizationId,
    session,
    { q, stageId, channel, assigned }
  );
  return Response.json(counts);
});
