import { apiError, withAuth } from "@/lib/api";
import { parseAssigned, parseInboxQuery } from "@/server/inbox/list-query";
import { listConversations } from "@/server/inbox/queries";
import type { ConversationsPage } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Lista de la Bandeja para quien pide (09: el Vendedor ve las suyas + las sin
 * asignar; el Propietario, todas). `?assigned=me|unassigned|all` (default
 * `all` = todo lo visible); otro valor → 422 `invalid_query`.
 *
 * 06 (contrato 06-0): `limit`, `cursor`, `filter`, `stage`, `channel`, `q`,
 * `ids`, `contact` y `since` se parsean TOLERANTES (`parseInboxQuery`).
 * Responde `{ conversations, nextCursor }`; sin `limit` = lista completa con
 * `nextCursor: null` (D-06-1). Precedencia: `ids` > `contact` > `since` >
 * lista paginada.
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
  const query = parseInboxQuery(url.searchParams);
  const page: ConversationsPage = await listConversations(
    session.organizationId,
    session,
    { ...query, assigned }
  );
  return Response.json(page);
});
