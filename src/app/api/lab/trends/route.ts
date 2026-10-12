import { withAuth } from "@/lib/api";
import { labErrorResponse } from "@/server/lab/errors";
import { runTrends } from "@/server/lab/history";
import { parseTrendsLimit } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * 08 — Tendencia de hallazgos por tipo y veredicto por persona (RF-08-10,
 * «Contrato 08-0»). Solo Propietario.
 *
 * GET `?limit=10` (1..50; inválido → 10)
 *   → 200 `LabTrendsDto` (corridas `done`, más reciente primero).
 */
export const GET = withAuth(async (session, req: Request) => {
  const limit = parseTrendsLimit(new URL(req.url).searchParams.get("limit"));
  try {
    return Response.json(await runTrends(session.organizationId, limit));
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
