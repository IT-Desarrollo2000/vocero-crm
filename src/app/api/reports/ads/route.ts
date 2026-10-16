import { apiError, withAuth } from "@/lib/api";
import { REPORT_TIMEOUT_MESSAGE } from "@/lib/reports";
import { getBranding } from "@/server/branding";
import { adsReport } from "@/server/reports/ads";
import { parseReportRange } from "@/server/reports/range";
import { ReportTimeoutError } from "@/server/reports/run";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/**
 * 020 fase B — Reportes → Anuncios. Solo Propietario (403 `forbidden` al
 * Vendedor, D4). NO va detrás de `ATRIBUCION`: desde la fase A el anuncio de
 * origen es dato interno y se captura siempre; la bandera solo gobierna el
 * `ctwa_clid` y la Conversions API.
 *
 * GET con los mismos parámetros de rango que `/api/reports/agent`
 *   (`?range=7d|30d|90d` · `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)
 *   → 200 `AdsReportDto` (`src/lib/reports.ts`), cada bloque
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
      const report = await adsReport(session.organizationId, parsed.range, currency);
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
