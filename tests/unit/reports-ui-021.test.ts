import { describe, expect, it } from "vitest";
import type {
  ReportRangeDto,
  SalesReportDto,
  SalesSourceRowDto,
  SalesSummaryDto,
  SummaryAdOriginRowDto,
  SummaryExternalOriginDto,
  SummaryOriginFiguresDto,
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
  salesSourceRows,
} from "@/components/reports/sales-report-format";
import {
  SUMMARY_BLOCKS,
  adRowLabels,
  currentHourIfToday,
  isSummaryReportEmpty,
  nowInZone,
  originTotals,
  rateDetail,
  showExternalOrigins,
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

const figures = (o: Partial<SummaryOriginFiguresDto> = {}): SummaryOriginFiguresDto => ({
  leads: 0,
  newLeads: 0,
  wrote: 0,
  inbound: 0,
  contacted: 0,
  attendedByAdvisor: 0,
  won: 0,
  wonAmount: money(0),
  ...o,
});

const extRow = (
  origin: SummaryExternalOriginDto["origin"],
  o: Partial<SummaryExternalOriginDto> = {}
): SummaryExternalOriginDto => ({
  origin,
  label: origin === "website" ? "Sitio web" : "FastApp (promotores)",
  received: 0,
  contacted: 0,
  notContacted: 0,
  replied: 0,
  firstContact: { measured: 0, p50Seconds: null, p90Seconds: null },
  ...o,
});

const adRow = (key: string, title: string, o: Partial<SummaryAdOriginRowDto> = {}): SummaryAdOriginRowDto => ({
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
    intakeEnabled: true,
    // 024: «Equipo» real; nadie concentra pendientes (1 de 2: por debajo del
    // mínimo), así que la lectura rápida de la 021 no cambia. Sin AGENDA.
    agendaEnabled: false,
    team: {
      ok: true,
      data: {
        currency: "MXN",
        rows: [
          { userId: "u_ana", name: "Ana", assignedInRange: 3, pending: 1, attended: 3, bookingsDone: null, won: 2, wonAmountCents: 150000 },
        ],
        others: null,
        unassigned: { userId: null, name: "Sin asignar", assignedInRange: 0, pending: 1, attended: 1, bookingsDone: null, won: 0, wonAmountCents: 0 },
        totals: { assignedInRange: 3, pending: 2, attended: 4, bookingsDone: null, won: 2, wonAmountCents: 150000 },
        topPending: { userId: "u_ana", name: "Ana", pending: 1, ofTotal: 2 },
      },
    },
    bookings: null,
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
        leads: 12,
        newLeads: 7,
        previous: null,
      },
    },
    byOrigin: {
      ok: true,
      data: {
        // 5 anuncios en el rango; solo 2 en las filas (las otras 3 suman 0).
        rows: [adRow("a1", "Promo", { leads: 4, won: 1 }), adRow("a2", "Promo", { leads: 2 })],
        total: 5,
        website: figures({ leads: 2, contacted: 1 }),
        fastApp: figures({ leads: 1 }),
        unidentified: figures({ leads: 3 }),
        totals: figures({ leads: 12, won: 2, wonAmount: money(150000) }),
      },
    },
    external: {
      ok: true,
      data: {
        rows: [
          extRow("website", { received: 3, contacted: 1, notContacted: 2 }),
          extRow("fast_app", { received: 1, contacted: 1 }),
        ],
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
    expect(reportTabLabel("/reports/sellers")).toBe("Vendedores");
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

  it("021b: ventas por origen enseña solo las fuentes con cierres, en su orden", () => {
    const row = (value: SalesSourceRowDto["value"], won: number, lost: number): SalesSourceRowDto => ({
      value, label: value, won, lost, closeRate: null, wonAmount: money(0),
    });
    expect(
      salesSourceRows([row("anuncio", 0, 0), row("web", 1, 0), row("promotor", 0, 2), row("desconocida", 1, 1)]).map((r) => r.value)
    ).toEqual(["web", "promotor", "desconocida"]);
    expect(SALES_BLOCKS).toContain("bySource");
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

  it("021b: el total por origen es el del servidor, no la suma de filas cortadas", () => {
    // Las filas visibles no se suman (los anuncios vienen cortados): el total viene aparte.
    const t = originTotals(summaryReport());
    expect(t?.leads).toBe(12);
    expect(t?.won).toBe(2);
    expect(originTotals(summaryReport({ byOrigin: { ok: false, error: "timeout" } }))).toBeNull();
  });

  it("021b: con la bandera apagada y sin datos, la UI no menciona el formulario ni FastApp", () => {
    expect(showExternalOrigins(summaryReport())).toBe(true);
    const apagadaVacia = summaryReport({
      intakeEnabled: false,
      byOrigin: {
        ok: true,
        data: { rows: [], total: 0, website: figures(), fastApp: figures(), unidentified: figures({ leads: 2 }), totals: figures({ leads: 2 }) },
      },
      external: { ok: true, data: { rows: [extRow("website"), extRow("fast_app")] } },
    });
    expect(showExternalOrigins(apagadaVacia)).toBe(false);
    // Apagada pero con leads de cuando estuvo encendida: se enseñan.
    expect(showExternalOrigins(summaryReport({ intakeEnabled: false }))).toBe(true);
    // Un bloque caído no la enciende.
    expect(
      showExternalOrigins({ ...apagadaVacia, byOrigin: { ok: false, error: "x" }, external: { ok: false, error: "x" } })
    ).toBe(false);
  });

  it("lectura rápida desde los datos; un bloque caído no inventa frases", () => {
    const h = summaryHighlights(summaryReport());
    const byKey = Object.fromEntries(h.map((x) => [x.key, x]));
    // 12 leads − 2 sitio web − 1 FastApp − 3 sin origen = 6 por anuncio.
    expect(byKey.ads?.text).toBe(
      "50 % de los leads del rango llegaron por un anuncio (6 de 12); 2 por el sitio web y 1 por FastApp."
    );
    expect(byKey.external?.text).toBe("2 leads del formulario y FastApp siguen sin contactar (2 del sitio web).");
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
    expect(caido.map((x) => x.key)).toEqual(["ads", "external", "pending", "sales"]);
    const sinOrigen = summaryHighlights(
      summaryReport({ byOrigin: { ok: false, error: "timeout" }, external: { ok: false, error: "timeout" } })
    );
    expect(sinOrigen.map((x) => x.key)).not.toContain("ads");
    expect(sinOrigen.map((x) => x.key)).not.toContain("external");
    const unoSolo = summaryHighlights(
      summaryReport({ external: { ok: true, data: { rows: [extRow("website"), extRow("fast_app", { received: 1, notContacted: 1 })] } } })
    ).find((x) => x.key === "external");
    expect(unoSolo?.text).toBe("1 lead del formulario y FastApp sigue sin contactar (1 de FastApp).");

    const soloAsesor = summaryHighlights(
      summaryReport({ responseTimes: { ok: false, error: "unavailable" } })
    ).find((x) => x.key === "response");
    expect(soloAsesor?.text).toBe(
      "Primera respuesta (mediana): un asesor atendió en 17 min (mediana, 4 personas)."
    );
  });

  it("vacío solo si se sabe que nadie escribió ni llegó ningún lead", () => {
    expect(isSummaryReportEmpty(summaryReport())).toBe(false);
    const base = summaryReport().attention;
    if (!base.ok) throw new Error("fixture");
    const att = (leads: number): SummaryReportDto["attention"] => ({
      ok: true,
      data: { ...base.data, persons: 0, inbound: 0, leads },
    });
    expect(isSummaryReportEmpty(summaryReport({ attention: att(0) }))).toBe(true);
    // Solo tarjetas de leads externos: NO está vacío.
    expect(isSummaryReportEmpty(summaryReport({ attention: att(2) }))).toBe(false);
    expect(isSummaryReportEmpty(summaryReport({ attention: { ok: false, error: "x" } }))).toBe(false);
  });
});
