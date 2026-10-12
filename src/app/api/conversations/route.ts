import { apiError, withAuth } from "@/lib/api";
import { listConversations } from "@/server/inbox/queries";
import type { AssignedFilter } from "@/lib/types";

export const dynamic = "force-dynamic";

const ASSIGNED: readonly AssignedFilter[] = ["me", "unassigned", "all"];

/**
 * Lista de la Bandeja para quien pide (09: el Vendedor ve las suyas + las sin
 * asignar; el Propietario, todas). `?assigned=me|unassigned|all` (default
 * `all` = todo lo visible); otro valor → 422 `invalid_query`.
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : undefined;
  const assignedParam = url.searchParams.get("assigned");
  if (
    assignedParam !== null &&
    !(ASSIGNED as readonly string[]).includes(assignedParam)
  ) {
    return apiError(
      422,
      "invalid_query",
      "assigned debe ser me, unassigned o all"
    );
  }
  const conversations = await listConversations(session.organizationId, session, {
    since: since && !Number.isNaN(since.getTime()) ? since : undefined,
    assigned: (assignedParam ?? "all") as AssignedFilter,
  });
  return Response.json({ conversations });
});
