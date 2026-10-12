import { apiError, withAuth } from "@/lib/api";
import { REPORT_TIMEOUT_MESSAGE } from "@/lib/reports";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { bookingReport } from "@/server/reports/bookings";
import { parseReportRange } from "@/server/reports/range";
import { ReportTimeoutError } from "@/server/reports/run";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/**
 * 10 — Reportes → Citas (dev-tasks/10-recordatorio-de-citas-y-no-shows.md,
 * «Contrato 10-0»). Solo Propietario (403 `forbidden` al Vendedor) y solo con
 * AGENDA encendida (404 sin cuerpo si no).
 *
 * GET con los mismos parámetros de rango que `/api/reports/agent`
 *   (`?range=7d|30d|90d` · `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)
 *   → 200 `BookingReportDto` (`src/lib/reports.ts`), cada bloque
 *     `{ ok: true, data } | { ok: false, error }`
 *   · 422 `invalid_range` · 503 `report_timeout`.
 */
export const GET = withAuth(
  async (session, req: Request) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    const tz = await reportTimezone(session.organizationId);
    const parsed = parseReportRange(new URL(req.url).searchParams, tz);
    if (!parsed.ok) return apiError(422, "invalid_range", parsed.message);

    try {
      const report = await bookingReport(
        session.organizationId,
        parsed.range,
        new Date()
      );
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
