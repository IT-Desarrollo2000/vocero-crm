import { withAuth } from "@/lib/api";
import { labErrorResponse } from "@/server/lab/errors";
import { diffRuns } from "@/server/lab/history";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 08 — "Qué cambió" entre dos corridas (RF-08-16, «Contrato 08-0»). Solo
 * Propietario.
 *
 * GET `?against=<runId>` (default: la corrida `done` anterior con snapshot)
 *   → 200 `LabRunDiffDto` (`{ available: false, reason }` si falta snapshot
 *     o no hay anterior)
 *   · 404 `not_found` (alguna corrida no es de la org).
 */
export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const against = new URL(req.url).searchParams.get("against") || undefined;
  try {
    return Response.json(await diffRuns(session.organizationId, id, against));
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
