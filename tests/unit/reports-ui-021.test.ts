import { describe, expect, it } from "vitest";
import type {
  ReportRangeDto,
  SalesReportDto,
  SalesSummaryDto,
  SummaryAdFiguresDto,
  SummaryAdRowDto,
  SummaryReportDto,
  WonAmountDto,
} from "@/lib/reports";
import { canSuggestShorter } from "@/components/reports/range-params";
import { reportTabLabel } from "@/components/reports/report-print";
import { classifyBlocksReport } from "@/components/reports/report-response";
import {
  SALES_BLOCKS,
  compareDetail,
  formatDays,
  formatTicket,
  salesCaveats,
  salesDayGeometry,
} from "@/components/reports/sales-report-format";
import {
  SUMMARY_BLOCKS,
  adRowLabels,
  adTotals,
  currentHourIfToday,
  isSummaryReportEmpty,
  nowInZone,
  rateDetail,
  summaryHighlights,
} from "@/components/reports/summary-report-format";

const RANGE: ReportRangeDto = {
  preset: "7d",
  from: "2026-10-13",
  to: "2026-10-19",
  days: ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"],
  tz: "America/Mexico_City",
  fromUtc: "2026-10-13T06:00:00.000Z",
  toUtc: "2026-10-20T06:00:00.000Z",
};

const money = (amountCents: number, extra: Partial<WonAmountDto> = {}): WonAmountDto => ({
  currency: "MXN",
  amountCents,
  otherCurrencies: [],
  wonWithoutAmount: 0,
  ...extra,
});

const figures = (o: Partial<SummaryAdFiguresDto> = {}): SummaryAdFiguresDto => ({
  persons: 0,
  newPersons: 0,
  inbound: 0,
  answered: 0,
  attendedByAdvisor: 0,
  won: 0,
  wonAmount: money(0),
  ...o,
});

const adRow = (key: string, title: string, o: Partial<SummaryAdRowDto> = {}): SummaryAdRowDto => ({
  ...figures(),
  key,
  sourceId: key,
  sourceType: "ad",
  title,
  ...o,
});

const salesSummary = (o: Partial<SalesSummaryDto> = {}): SalesSummaryDto => ({
  won: 0,
  lost: 0,
  closeRate: null,
  wonAmount: money(0),
  averageTicketCents: null,
  approximateCount: 0,
  withoutDate: 0,
  previous: null,
  ...o,
});

function summaryReport(o: Partial<SummaryReportDto> = {}): SummaryReportDto {
  return {
    range: RANGE,
    attention: {
      ok: true,
      data: {
        inbound: 40,
        outbound: 30,
        outboundByOrigin: { ai: 20, advisor: 8, template: 2 },
        persons: 10,
        newPersons: 6,
        answered: 9,
        answeredRate: 0.9,
        attendedByAdvisor: 4,
        attendedByAdvisorRate: 0.4,
        handedOff: 3,
        advisorFirstReply: { persons: 4, p50Seconds: 1020, p90Seconds: 3600 },
        previous: null,
      },
    },
    byAd: {
      ok: true,
      data: {
        rows: [adRow("a1", "Promo", { persons: 4, won: 1 }), adRow("a2", "Promo", { persons: 2 })],
        total: 5,
        unidentified: figures({ persons: 3 }),
      },
    },
    byChannel: { ok: true, data: { rows: [] } },
    byHour: { ok: true, data: { rows: [] } },
    pending: { ok: true, data: { total: 2, rows: [] } },
    sales: { ok: true, data: salesSummary({ won: 2, lost: 2, closeRate: 0.5, wonAmount: money(150000) }) },
    responseTimes: {
      ok: true,
      data: {
        ai: { sessions: 5, p50Seconds: 4, p90Seconds: 10 },
        human: { sessions: 2, p50Seconds: 600, p90Seconds: 900 },
        unanswered: 1,
      },
    },
    ...o,
  };
}

describe("021 — rango y pestañas", () => {
  it("«Probar con 30 días» solo cuando el rango es más largo que 30 días", () => {
    expect(canSuggestShorter({ preset: "today" })).toBe(false);
    expect(canSuggestShorter({ preset: "7d" })).toBe(false);
    expect(canSuggestShorter({ preset: "30d" })).toBe(false);
    expect(canSuggestShorter({ preset: "90d" })).toBe(true);
    expect(canSuggestShorter({ preset: "custom", from: "2026-10-01", to: "2026-10-19" })).toBe(false);
    expect(canSuggestShorter({ preset: "custom", from: "2026-08-01", to: "2026-10-19" })).toBe(true);
  });

  it("el título del PDF conoce las pestañas nuevas", () => {
    expect(reportTabLabel("/reports/summary")).toBe("Resumen");
    expect(reportTabLabel("/reports/sales")).toBe("Ventas");
    expect(reportTabLabel("/reports/agent")).toBe("Agente");
  });
});

describe("021 — respuesta de Ventas y Resumen", () => {
  const salesBody = {
    range: RANGE,
    ...Object.fromEntries(SALES_BLOCKS.map((b) => [b, { ok: false, error: "timeout" }])),
  };

  it("200 con todos los bloques → ok (aunque un bloque falle)", () => {
    expect(classifyBlocksReport<SalesReportDto>(200, salesBody, SALES_BLOCKS).kind).toBe("ok");
  });

  it("200 sin un bloque exigido o sin rango → error, no una pantalla vacía", () => {
    const { byDay: _omit, ...sinBloque } = salesBody as Record<string, unknown>;
    void _omit;
    expect(classifyBlocksReport<SalesReportDto>(200, sinBloque, SALES_BLOCKS).kind).toBe("error");
    expect(classifyBlocksReport<SalesReportDto>(200, { ...salesBody, range: null }, SALES_BLOCKS).kind).toBe("error");
    expect(classifyBlocksReport<SummaryReportDto>(200, null, SUMMARY_BLOCKS).kind).toBe("error");
  });

  it("503, 422 con mensaje, 401 y 403/404", () => {
    expect(classifyBlocksReport<SalesReportDto>(503, null, SALES_BLOCKS)).toEqual({ kind: "timeout" });
    expect(
      classifyBlocksReport<SalesReportDto>(422, { error: { message: "Rango inválido" } }, SALES_BLOCKS)
    ).toEqual({ kind: "invalid", message: "Rango inválido" });
    expect(classifyBlocksReport<SalesReportDto>(401, null, SALES_BLOCKS).kind).toBe("unauthorized");
    expect(classifyBlocksReport<SummaryReportDto>(404, null, SUMMARY_BLOCKS).kind).toBe("forbidden");
  });
});

describe("021 — Ventas: formato", () => {
  it("días de cierre legibles", () => {
    expect(formatDays(null)).toBe("—");
    expect(formatDays(0.2)).toBe("menos de 1 día");
    expect(formatDays(1)).toBe("1 día");
    expect(formatDays(3.46)).toBe("3.5 días");
    expect(formatDays(12)).toBe("12 días");
  });

  it("ticket sin ventas con monto → «—»", () => {
    expect(formatTicket(null, "MXN")).toBe("—");
    expect(formatTicket(125000, "MXN")).toContain("1,250.00");
  });

  it("comparación con el periodo anterior", () => {
    const prev = { from: "2026-10-06", to: "2026-10-12" };
    expect(compareDetail(5, 4, prev)).toBe("+25 % vs. 6 oct – 12 oct 2026");
    expect(compareDetail(0, 0, prev)).toBeUndefined();
    expect(compareDetail(3, undefined, null)).toBeUndefined();
  });

  it("un solo día no queda como una astilla; muchos días siguen delgados", () => {
    const one = salesDayGeometry(1);
    expect(one.plotWidth).toBeGreaterThanOrEqual(320);
    expect(one.barWidth).toBeLessThanOrEqual(40);
    const ninety = salesDayGeometry(90);
    expect(ninety.barWidth).toBeLessThan(10);
    expect(ninety.plotWidth).toBe(90 * ninety.step);
  });

  it("«Cómo se cuenta» explica sin fecha / aproximadas solo si las hay", () => {
    expect(salesCaveats(salesSummary())).toEqual([]);
    const notes = salesCaveats(salesSummary({ withoutDate: 2, approximateCount: 1 }));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("2 leads están en Ganado sin fecha");
    expect(notes[1]).toContain("1 cierre del periodo tiene fecha aproximada");
  });
});

describe("021 — Resumen: cifras", () => {
  it("una tasa se compara con la tasa anterior, no con «+%»", () => {
    expect(rateDetail(8, 10, 0.7)).toBe("8 de 10 · antes 70 %");
    expect(rateDetail(8, 10, null)).toBe("8 de 10");
  });

  it("hoy y la hora en la zona del negocio", () => {
    // 19-oct 01:30 UTC = 18-oct 19:30 en Ciudad de México.
    const now = new Date("2026-10-19T01:30:00Z");
    expect(nowInZone("America/Mexico_City", now)).toEqual({ day: "2026-10-18", hour: 19 });
    expect(currentHourIfToday({ to: "2026-10-18", tz: "America/Mexico_City" }, now)).toBe(19);
    expect(currentHourIfToday({ to: "2026-10-17", tz: "America/Mexico_City" }, now)).toBeNull();
    expect(nowInZone("UTC", new Date("2026-10-19T00:05:00Z")).hour).toBe(0);
  });

  it("titulares repetidos se distinguen por id", () => {
    const labels = adRowLabels([
      adRow("a1", "Promo"),
      adRow("a2", "Promo"),
      adRow("p1", "Otra", { sourceType: "post" }),
    ]);
    expect(labels.get("a1")).toEqual({ title: "Promo", subtitle: "anuncio a1" });
    expect(labels.get("a2")?.subtitle).toBe("anuncio a2");
    expect(labels.get("p1")?.subtitle).toBeNull();
  });

  it("el total por anuncio sale de atención y ventas, no de sumar filas cortadas", () => {
    const t = adTotals(summaryReport());
    expect(t?.partial).toBe(false);
    // Filas visibles suman 4 + 2 + 3 = 9, pero hay 10 personas en el rango.
    expect(t?.figures.persons).toBe(10);
    expect(t?.figures.won).toBe(2);
    const sinAtencion = adTotals(summaryReport({ attention: { ok: false, error: "timeout" } }));
    expect(sinAtencion?.partial).toBe(true);
    expect(sinAtencion?.figures.persons).toBe(9);
  });

  it("lectura rápida desde los datos; un bloque caído no inventa frases", () => {
    const h = summaryHighlights(summaryReport());
    const byKey = Object.fromEntries(h.map((x) => [x.key, x]));
    // 10 personas − 3 sin anuncio = 7 por anuncio.
    expect(byKey.ads?.text).toContain("70 %");
    expect(byKey.ads?.text).toContain("7 de 10");
    // El asesor sale de advisorFirstReply (17 min), NO de M4 (10 min).
    expect(byKey.response?.text).toBe(
      "Primera respuesta (mediana): IA 4 s · un asesor atendió en 17 min (mediana, 4 personas)."
    );
    expect(byKey.response?.agentLink).toBe(true);
    expect(byKey.outbound?.text).toContain("20 de la IA, 8 de asesores y 2 plantillas");
    expect(byKey.handoff?.text).toContain("3 conversaciones pasaron");
    expect(byKey.pending?.text).toContain("2 personas esperan");
    expect(byKey.sales?.text).toContain("2 ventas");

    const caido = summaryHighlights(
      summaryReport({
        attention: { ok: false, error: "timeout" },
        responseTimes: { ok: false, error: "unavailable" },
      })
    );
    expect(caido.map((x) => x.key)).toEqual(["pending", "sales"]);

    const soloAsesor = summaryHighlights(
      summaryReport({ responseTimes: { ok: false, error: "unavailable" } })
    ).find((x) => x.key === "response");
    expect(soloAsesor?.text).toBe(
      "Primera respuesta (mediana): un asesor atendió en 17 min (mediana, 4 personas)."
    );
  });

  it("vacío solo si se sabe que nadie escribió", () => {
    expect(isSummaryReportEmpty(summaryReport())).toBe(false);
    expect(isSummaryReportEmpty(summaryReport({ attention: { ok: false, error: "x" } }))).toBe(false);
  });
});
