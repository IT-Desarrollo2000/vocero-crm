import { apiError, withAuth } from "@/lib/api";
import { REPORT_TIMEOUT_MESSAGE } from "@/lib/reports";
import { getBranding } from "@/server/branding";
import { parseReportRange } from "@/server/reports/range";
import { ReportTimeoutError } from "@/server/reports/run";
import { summaryReport } from "@/server/reports/summary";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/**
 * 021 — Reportes → Resumen para dirección. Solo Propietario (403
 * `forbidden` al Vendedor). Atención, origen (anuncio, sitio web, FastApp),
 * leads del formulario y FastApp (021b), canal, hora,
 * pendientes, ventas (las de `/api/reports/sales`) y tiempos de primera
 * respuesta (los de `/api/reports/agent`); semántica en
 * `src/server/reports/summary.ts`.
 *
 * GET con los mismos parámetros de rango que `/api/reports/agent`
 *   (`?range=today|7d|30d|90d` · `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)
 *   → 200 `SummaryReportDto` (`src/lib/reports.ts`), cada bloque
 *     `{ ok: true, data } | { ok: false, error }`
 *   · 422 `invalid_range` · 503 `report_timeout`.
 */
export const GET = withAuth(
  async (session, req: Request) => {
    const tz = await reportTimezone(session.organizationId);
    const parsed = parseReportRange(new URL(req.url).searchParams, tz);
    if (!parsed.ok) return apiError(422, "invalid_range", parsed.message);

    try {
      const { currency } = await getBranding(session.organizationId);
      const report = await summaryReport(session.organizationId, parsed.range, currency);
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
