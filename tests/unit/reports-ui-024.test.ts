import { describe, expect, it } from "vitest";
import type {
  BookingSellerRowDto,
  ReportRangeDto,
  SellerRosterRowDto,
  SellerSalesRowDto,
  SellersReportDto,
  SummaryReportDto,
  WonAmountDto,
} from "@/lib/reports";
import { classifyBlocksReport } from "@/components/reports/report-response";
import {
  SELLERS_BLOCKS,
  sellerResults,
  sumWonAmounts,
} from "@/components/reports/sellers-report-format";
import {
  SUMMARY_BLOCKS,
  bookingsPeriodText,
  summaryHighlights,
  teamPendingHighlight,
} from "@/components/reports/summary-report-format";

const RANGE: ReportRangeDto = {
  preset: "7d",
  from: "2026-10-15",
  to: "2026-10-21",
  days: ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"],
  tz: "America/Mexico_City",
  fromUtc: "2026-10-15T06:00:00.000Z",
  toUtc: "2026-10-22T06:00:00.000Z",
};

const money = (amountCents: number, extra: Partial<WonAmountDto> = {}): WonAmountDto => ({
  currency: "MXN",
  amountCents,
  otherCurrencies: [],
  wonWithoutAmount: 0,
  ...extra,
});

const rosterRow = (userId: string | null, name: string, o: Partial<SellerRosterRowDto> = {}): SellerRosterRowDto => ({
  userId,
  name,
  role: userId ? "member" : null,
  isMember: !!userId,
  portfolio: 0,
  assignedInRange: 0,
  activePortfolio: 0,
  persons: 0,
  attended: 0,
  attendedRate: null,
  pending: 0,
  externalNotContacted: 0,
  advisorFirstReply: { persons: 0, p50Seconds: null, p90Seconds: null },
  ...o,
});

const salesRow = (userId: string | null, name: string, o: Partial<SellerSalesRowDto> = {}): SellerSalesRowDto => ({
  userId,
  name,
  won: 0,
  lost: 0,
  closeRate: null,
  wonAmount: money(0),
  averageTicketCents: null,
  ...o,
});

const bookingRow = (userId: string | null, name: string, o: Partial<BookingSellerRowDto> = {}): BookingSellerRowDto => ({
  userId,
  name,
  isMember: !!userId,
  bySource: { manual: 0, ai: 0 },
  total: 0,
  scheduled: 0,
  realizada: 0,
  noShow: 0,
  cancelada: 0,
  rate: null,
  pendingToMark: 0,
  ...o,
});

function sellersReport(o: Partial<SellersReportDto> = {}): SellersReportDto {
  return {
    range: RANGE,
    agendaEnabled: true,
    roster: {
      ok: true,
      data: {
        rows: [
          rosterRow("u_ana", "Ana", { portfolio: 5, persons: 4, attended: 3, attendedRate: 0.75, pending: 1 }),
          // Bea es miembro pero no tiene nada: sale en cero.
          rosterRow("u_bea", "Bea"),
          rosterRow(null, "Sin asignar", { portfolio: 2, persons: 2, pending: 2 }),
        ],
        totals: { ...rosterRow(null, "x", { portfolio: 7, persons: 6, attended: 3, attendedRate: 0.5, pending: 3 }) },
      },
    },
    sales: {
      ok: true,
      data: {
        rows: [
          salesRow("u_ana", "Ana", { won: 2, lost: 1, closeRate: 2 / 3, wonAmount: money(300000), averageTicketCents: 150000 }),
          // Ex-miembro: tiene ventas pero ya no está en el roster.
          salesRow("u_ex", "Ex", { won: 1, wonAmount: money(0, { otherCurrencies: [{ currency: "USD", amountCents: 5000, won: 1 }] }) }),
          salesRow(null, "Sin asesor", { lost: 2 }),
        ],
      },
    },
    bookings: {
      ok: true,
      data: {
        rows: [
          bookingRow("u_ana", "Ana"),
          bookingRow("u_bea", "Bea", { total: 3, realizada: 1, noShow: 1, cancelada: 1, rate: 0.5, bySource: { manual: 2, ai: 1 } }),
          bookingRow(null, "Sin vendedor", { total: 1, realizada: 1, rate: 1 }),
        ],
      },
    },
    funnel: { ok: true, data: { currency: "MXN", stages: [], rows: [] } },
    ...o,
  };
}

describe("024 — Vendedores: respuesta", () => {
  it("200 sin citas (`bookings: null`, AGENDA apagada) sigue siendo ok", () => {
    const body = { ...sellersReport(), agendaEnabled: false, bookings: null };
    expect(classifyBlocksReport<SellersReportDto>(200, body, SELLERS_BLOCKS).kind).toBe("ok");
    const { roster: _omit, ...sinRoster } = body;
    void _omit;
    expect(classifyBlocksReport<SellersReportDto>(200, sinRoster, SELLERS_BLOCKS).kind).toBe("error");
    expect(classifyBlocksReport<SellersReportDto>(403, null, SELLERS_BLOCKS).kind).toBe("forbidden");
  });

  it("el Resumen exige «Equipo» pero no `bookings` (null sin AGENDA)", () => {
    expect(SUMMARY_BLOCKS).toContain("team");
    expect(SUMMARY_BLOCKS as readonly string[]).not.toContain("bookings");
  });
});

describe("024 — Vendedores: unión de bloques", () => {
  it("el roster es la columna vertebral; las filas null NO se mezclan entre bloques", () => {
    const r = sellerResults(sellersReport());
    expect(r.rows.map((x) => [x.key, x.name])).toEqual([
      ["user:u_ana", "Ana"],
      ["user:u_bea", "Bea"],
      ["user:u_ex", "Ex"],
      ["none:sales", "Sin asesor"],
      ["none:bookings", "Sin vendedor"],
    ]);
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    // Bea: ventas en cero (del roster), citas suyas.
    expect(by["user:u_bea"]?.sales?.won).toBe(0);
    expect(by["user:u_bea"]?.bookings?.total).toBe(3);
    // El ex-miembro: ventas sí, citas en cero.
    expect(by["user:u_ex"]?.bookings?.total).toBe(0);
    // «Sin asesor» solo trae ventas; «Sin vendedor» solo citas.
    expect(by["none:sales"]?.bookings).toBeNull();
    expect(by["none:bookings"]?.sales).toBeNull();
    // «Sin asignar» (cartera) no aparece en Resultados.
    expect(r.rows.some((x) => x.name === "Sin asignar")).toBe(false);
  });

  it("el total suma TODAS las filas de cada bloque, sin mezclar monedas", () => {
    const { total, salesOk, bookingsOk } = sellerResults(sellersReport());
    expect(salesOk && bookingsOk).toBe(true);
    expect(total.sales?.won).toBe(3);
    expect(total.sales?.lost).toBe(3);
    expect(total.sales?.closeRate).toBe(0.5);
    expect(total.sales?.wonAmount.amountCents).toBe(300000);
    expect(total.sales?.wonAmount.otherCurrencies).toEqual([{ currency: "USD", amountCents: 5000, won: 1 }]);
    // Ticket = 3,000.00 entre las 2 ventas con monto en MXN.
    expect(total.sales?.averageTicketCents).toBe(150000);
    expect(total.bookings).toEqual({ total: 4, realizada: 2, noShow: 1, cancelada: 1, rate: 2 / 3 });
  });

  it("sin AGENDA no hay columnas de citas; un bloque caído no inventa ceros", () => {
    const off = sellerResults(sellersReport({ agendaEnabled: false, bookings: null }));
    expect(off.bookingsOk).toBe(false);
    expect(off.rows.every((x) => x.bookings === null)).toBe(true);
    expect(off.rows.some((x) => x.key === "none:bookings")).toBe(false);
    const caida = sellerResults(sellersReport({ sales: { ok: false, error: "timeout" } }));
    expect(caida.salesOk).toBe(false);
    expect(caida.rows.every((x) => x.sales === null)).toBe(true);
    expect(caida.total.sales).toBeNull();
  });

  it("sin roster, las filas salen de ventas y citas", () => {
    const r = sellerResults(sellersReport({ roster: { ok: false, error: "timeout" } }));
    expect(r.rows.map((x) => x.key)).toEqual(["user:u_ana", "user:u_ex", "user:u_bea", "none:sales", "none:bookings"]);
  });

  it("sumWonAmounts junta otras monedas por moneda", () => {
    const s = sumWonAmounts("MXN", [
      money(100, { otherCurrencies: [{ currency: "USD", amountCents: 10, won: 1 }], wonWithoutAmount: 1 }),
      money(50, { otherCurrencies: [{ currency: "USD", amountCents: 5, won: 1 }, { currency: "EUR", amountCents: 7, won: 1 }] }),
    ]);
    expect(s).toEqual({
      currency: "MXN",
      amountCents: 150,
      wonWithoutAmount: 1,
      otherCurrencies: [
        { currency: "EUR", amountCents: 7, won: 1 },
        { currency: "USD", amountCents: 15, won: 2 },
      ],
    });
  });
});

describe("024 — Resumen: Equipo y citas en la lectura rápida", () => {
  const base = (o: Partial<SummaryReportDto> = {}): SummaryReportDto => ({
    range: RANGE,
    intakeEnabled: false,
    agendaEnabled: false,
    attention: { ok: false, error: "x" },
    byOrigin: { ok: false, error: "x" },
    external: { ok: false, error: "x" },
    byChannel: { ok: false, error: "x" },
    byHour: { ok: false, error: "x" },
    pending: { ok: false, error: "x" },
    sales: { ok: false, error: "x" },
    responseTimes: { ok: false, error: "x" },
    team: { ok: false, error: "x" },
    bookings: null,
    ...o,
  });
  const team = (pending: number, ofTotal: number): SummaryReportDto["team"] => {
    const f = { assignedInRange: 0, pending: 0, attended: 0, bookingsDone: null, won: 0, wonAmountCents: 0 };
    return {
      ok: true,
      data: {
        currency: "MXN",
        rows: [{ userId: "u_e", name: "Ericka", ...f, pending }],
        others: null,
        unassigned: { userId: null, name: "Sin asignar", ...f, pending: ofTotal - pending },
        totals: { ...f, pending: ofTotal },
        topPending: { userId: "u_e", name: "Ericka", pending, ofTotal },
      },
    };
  };

  it("la viñeta de concentración exige ≥ 3 pendientes y ≥ 40 %", () => {
    expect(teamPendingHighlight(base({ team: team(18, 33) }))).toBe(
      "Ericka tiene 18 de 33 pendientes de respuesta (según la asignación actual)."
    );
    // 40 % exacto sí; 39 % no.
    expect(teamPendingHighlight(base({ team: team(2, 5) }))).not.toBeNull();
    expect(teamPendingHighlight(base({ team: team(39, 100) }))).toBeNull();
    // 2 de 2 es 100 %, pero con menos de 3 pendientes no es noticia.
    expect(teamPendingHighlight(base({ team: team(2, 2) }))).toBeNull();
    expect(teamPendingHighlight(base())).toBeNull();
    const h = summaryHighlights(base({ team: team(18, 33) }));
    expect(h.find((x) => x.key === "team-pending")?.sellersLink).toBe(true);
  });

  it("«Citas del periodo» solo con AGENDA y alguna cita", () => {
    const counts = { total: 6, scheduled: 2, realizada: 3, noShow: 1, cancelada: 0, rate: 0.75, pendingToMark: 0 };
    expect(bookingsPeriodText(counts)).toBe("Citas del periodo: 6 agendadas · 3 realizadas · asistencia 75 %.");
    expect(bookingsPeriodText({ ...counts, total: 1, realizada: 1, rate: null })).toBe(
      "Citas del periodo: 1 agendada · 1 realizada · asistencia —."
    );
    const on = summaryHighlights(base({ agendaEnabled: true, bookings: { ok: true, data: counts } }));
    expect(on.map((x) => x.key)).toEqual(["bookings"]);
    const vacio = summaryHighlights(base({ agendaEnabled: true, bookings: { ok: true, data: { ...counts, total: 0 } } }));
    expect(vacio).toEqual([]);
    expect(summaryHighlights(base({ agendaEnabled: false, bookings: null }))).toEqual([]);
  });
});
