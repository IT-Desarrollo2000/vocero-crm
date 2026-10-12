import { apiError, withAuth } from "@/lib/api";
import { REPORT_TIMEOUT_MESSAGE } from "@/lib/reports";
import { agentReport } from "@/server/reports/agent";
import { parseReportRange } from "@/server/reports/range";
import { ReportTimeoutError } from "@/server/reports/run";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/**
 * 02 — Reportes → Agente (dev-tasks/02-metricas-del-agente.md). Solo
 * Propietario: el Vendedor recibe 403 `forbidden` (RF-02-02).
 *
 * GET `?range=7d|30d|90d` · `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`
 *   (también `range=7|30|90` y `from`/`to` solos; sin parámetros → 30d)
 *   → 200 `AgentReportDto` (`src/lib/reports.ts`), cada bloque
 *     `{ ok: true, data } | { ok: false, error }`
 *   · 422 `invalid_range` (fecha ilegible, from > to, > 366 días, preset raro)
 *   · 503 `report_timeout` si TODO el reporte excede el tiempo.
 */
export const GET = withAuth(
  async (session, req: Request) => {
    const tz = await reportTimezone(session.organizationId);
    const parsed = parseReportRange(new URL(req.url).searchParams, tz);
    if (!parsed.ok) return apiError(422, "invalid_range", parsed.message);

    try {
      const report = await agentReport(session.organizationId, parsed.range);
      return Response.json(report, {
        headers: { "Cache-Control": "private, max-age=60" },
      });
    } catch (err) {
      if (err instanceof ReportTimeoutError) {
        return apiError(503, "report_timeout", REPORT_TIMEOUT_MESSAGE);
      }
      throw err;
    }
  },
  { role: "owner" }
);
