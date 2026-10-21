import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  BOOKING_REPORT_SQL,
  bookingReport,
  shapeAttendance,
  shapeByReminder,
  shapeByType,
  shapeBySeller,
  shapeOffers,
  shapeToSales,
  type BookingReportParams,
} from "@/server/reports/bookings";
import { parseReportRange } from "@/server/reports/range";

/**
 * 10 — Reportes → Citas (RF-10-15): proporciones `null` sin denominador,
 * Laboratorio y bloqueos fuera de TODA consulta, tenant obligatorio y nada de
 * `now()` en SQL.
 */

const dialect = new PgDialect();
const P: BookingReportParams = {
  organizationId: "org_1",
  fromUtc: new Date("2026-09-12T06:00:00.000Z"),
  toUtc: new Date("2026-10-12T06:00:00.000Z"),
  now: new Date("2026-10-12T18:00:00.000Z"),
};

describe("forma de los bloques", () => {
  it("sin datos: ceros y proporciones null (nunca NaN)", () => {
    expect(shapeOffers([], [])).toEqual({
      conversationsWithOffer: 0,
      converted: 0,
      rate: null,
      offerRounds: 0,
      dataSince: null,
    });
    expect(shapeAttendance([])).toEqual({
      realizada: 0,
      noShow: 0,
      rate: null,
      pendingToMark: 0,
      cancelada: 0,
      total: 0,
      scheduled: 0,
    });
    expect(shapeByReminder([])).toEqual({
      withReminder: { realizada: 0, noShow: 0, rate: null },
      withoutReminder: { realizada: 0, noShow: 0, rate: null },
    });
  });

  it("10 conversaciones con oferta y 4 con cita de la IA → 40 %", () => {
    const dto = shapeOffers(
      [{ conversations: "10", converted: "4", rounds: "13" }],
      [{ since: "2026-10-01T00:00:00.000Z" }]
    );
    expect(dto).toMatchObject({ rate: 0.4, offerRounds: 13, dataSince: "2026-10-01T00:00:00.000Z" });
  });

  it("asistencia y desglose con/sin recordatorio (el driver manda texto)", () => {
    expect(shapeAttendance([{ total: 12, agendada: 3, realizada: 3, no_show: 1, pending_to_mark: 2, cancelada: 5 }])).toEqual({
      realizada: 3,
      noShow: 1,
      rate: 0.75,
      pendingToMark: 2,
      cancelada: 5,
      total: 12,
      scheduled: 3,
    });
    const by = shapeByReminder([
      { with_reminder: true, realizada: "4", no_show: "0" },
      { with_reminder: "f", realizada: "1", no_show: "3" },
    ]);
    expect(by.withReminder.rate).toBe(1);
    expect(by.withoutReminder.rate).toBe(0.25);
  });
});

describe("SQL", () => {
  const all = Object.entries(BOOKING_REPORT_SQL).map(
    ([name, build]) => [name, dialect.sqlToQuery((build as (p: BookingReportParams) => SQL)(P))] as const
  );

  it("tenant en todas; nada de now() de SQL", () => {
    for (const [name, q] of all) {
      const i = q.params.indexOf("org_1");
      expect(i, name).toBeGreaterThanOrEqual(0);
      expect(q.sql, name).toContain(`"organization_id" = $${i + 1}`);
      expect(q.sql.toLowerCase(), name).not.toMatch(/now\(\)|current_timestamp/);
    }
  });

  it("el Laboratorio y los bloqueos quedan fuera", () => {
    for (const [name, q] of all) {
      if (name === "offersSinceSql") continue; // aviso de la UI: desde cuándo hay datos
      expect(q.sql, name).toMatch(/"is_test" = false/);
    }
    const offers = all.find(([n]) => n === "offersSql")![1].sql;
    expect(offers).toContain(`"booking"."source" = 'ai'`);
    expect(offers).toContain(`"booking"."kind" = 'session'`);
    for (const name of ["attendanceSql", "byReminderSql"]) {
      expect(all.find(([n]) => n === name)![1].sql).toContain(`"booking"."kind" = 'session'`);
    }
  });

  it("los límites viajan como texto ::timestamp", () => {
    const q = all.find(([n]) => n === "attendanceSql")![1];
    expect(q.params).toContain("2026-09-12 06:00:00.000");
    expect(q.params).toContain("2026-10-12 18:00:00.000"); // now (pendientes de marcar)
  });
});

describe("bookingReport", () => {
  it("los bloques con el rango; uno caído no tumba los demás", async () => {
    const parsed = parseReportRange({ range: "30d" }, "America/Mexico_City", P.now);
    if (!parsed.ok) throw new Error(parsed.message);
    let i = 0;
    const report = await bookingReport("org_1", parsed.range, P.now, "MXN", {
      runReadOnly: async (fn) =>
        fn(async () => {
          i++;
          if (i === 1) throw new Error("boom");
          return [];
        }),
      blocks: { concurrency: 1, onError: () => {} },
    });
    expect(report.range.preset).toBe("30d");
    expect(report.offers).toEqual({ ok: false, error: "unavailable" });
    expect(report.attendance.ok).toBe(true);
    expect(report.byReminder.ok).toBe(true);
    expect(report.byType.ok && report.byType.data.rows.map((r) => r.name)).toEqual(["Sin tipo"]);
    expect(report.bySeller.ok && report.bySeller.data.rows.map((r) => r.name)).toEqual(["Sin vendedor"]);
    expect(report.toSales.ok && report.toSales.data).toMatchObject({ bookingsDone: 0, leads: 0, rate: null });
  });
});

describe("024 — por tipo, por vendedor y citas → ventas", () => {
  const render = (name: keyof typeof BOOKING_REPORT_SQL) =>
    dialect.sqlToQuery((BOOKING_REPORT_SQL[name] as (p: BookingReportParams) => SQL)(P));

  it("SQL: sesiones reales del rango (sin bloqueos ni Laboratorio); vendedor unido a TODOS los miembros", () => {
    for (const name of ["byTypeSql", "bySellerSql", "toSalesSql"] as const) {
      const s = render(name).sql;
      expect(s, name).toContain(`"booking"."kind" = 'session'`);
      expect(s, name).toContain(`"booking"."is_test" = false`);
      expect(s, name).toMatch(/"booking"."scheduled_at" >= \$\d+::timestamp/);
    }
    const seller = render("bySellerSql").sql;
    expect(seller).toContain("full join mem on mem.user_id = bs.user_id");
    expect(seller).toContain(`"member"."organization_id" = $`);
    const sales = render("toSalesSql").sql;
    expect(sales).toContain(`"booking"."status" = 'realizada'`);
    // El lead de la cita o, si no lo guardó, el del contacto (con tenant).
    expect(sales).toContain(`coalesce("booking"."lead_id", (`);
    expect(sales).toMatch(/"l0"."organization_id" = \$\d+ and "l0"."contact_id" = "booking"."contact_id"/);
    expect(sales).toContain("select distinct lead_id from rb where lead_id is not null");
    expect(sales).toContain(") g on true");
  });

  it("por tipo: activos también en cero, inactivos solo con citas, «Sin tipo» al final", () => {
    const dto = shapeByType(
      [
        { type_id: "at_b", total: 3, agendada: 1, realizada: 1, no_show: 1, pending_to_mark: 0, cancelada: 0 },
        { type_id: null, total: "2", agendada: 0, realizada: 2, no_show: 0, pending_to_mark: 0, cancelada: 0 },
        { type_id: "at_x", total: 1, agendada: 0, realizada: 1, no_show: 0, pending_to_mark: 0, cancelada: 0 },
      ],
      [
        { id: "at_a", name: "Prueba de manejo", active: true },
        { id: "at_b", name: "Servicio", active: "t" },
        { id: "at_off", name: "Viejo", active: false },
      ]
    );
    expect(dto.rows.map((r) => [r.typeId, r.total])).toEqual([
      ["at_a", 0],
      ["at_b", 3],
      [null, 3], // «Sin tipo» + la cita de un tipo fuera del catálogo
    ]);
    expect(dto.rows[0]!.rate).toBeNull();
    expect(dto.rows[1]).toMatchObject({ realizada: 1, noShow: 1, rate: 0.5, scheduled: 1 });
    expect(dto.rows[2]).toMatchObject({ name: "Sin tipo", realizada: 3, rate: 1 });
  });

  it("por vendedor: miembros en cero, manual vs IA, «Sin vendedor» al final", () => {
    const dto = shapeBySeller([
      { user_id: "u_ana", name: "Ana", is_member: true, source: "manual", total: 2, agendada: 0, realizada: 1, no_show: 1, pending_to_mark: 0, cancelada: 0 },
      { user_id: "u_ana", name: "Ana", is_member: true, source: "ai", total: 1, agendada: 1, realizada: 0, no_show: 0, pending_to_mark: 1, cancelada: 0 },
      { user_id: "u_beto", name: "Beto", is_member: true, source: null, total: null },
      { user_id: "u_ex", name: "ex@x.mx", is_member: false, source: "ai", total: 1, realizada: 1 },
      { user_id: null, name: null, is_member: false, source: "ai", total: 4, cancelada: 4 },
    ]);
    expect(dto.rows.map((r) => r.name)).toEqual(["Ana", "ex@x.mx", "Beto", "Sin vendedor"]);
    expect(dto.rows[0]).toMatchObject({ total: 3, realizada: 1, noShow: 1, rate: 0.5, pendingToMark: 1, bySource: { manual: 2, ai: 1 }, isMember: true });
    expect(dto.rows[1]).toMatchObject({ isMember: false, bySource: { manual: 0, ai: 1 } });
    expect(dto.rows[2]).toMatchObject({ total: 0, rate: null, isMember: true });
    expect(dto.rows[3]).toMatchObject({ userId: null, total: 4, cancelada: 4, bySource: { ai: 4 } });
  });

  it("citas → ventas: leads distintos, ganados hoy, monedas nunca sumadas", () => {
    expect(shapeToSales([{ bookings: 0, without_lead: 0, won: null, n: null }], "MXN")).toEqual({
      bookingsDone: 0,
      leads: 0,
      withoutLead: 0,
      won: 0,
      rate: null,
      wonAmount: { currency: "MXN", amountCents: 0, otherCurrencies: [], wonWithoutAmount: 0 },
    });
    const dto = shapeToSales(
      [
        { bookings: 6, without_lead: 1, won: true, currency: "MXN", has_amount: true, n: 2, cents: "300000" },
        { bookings: 6, without_lead: 1, won: true, currency: "USD", has_amount: true, n: 1, cents: 5000 },
        { bookings: 6, without_lead: 1, won: "t", currency: null, has_amount: false, n: 1, cents: 0 },
        { bookings: 6, without_lead: 1, won: false, currency: null, has_amount: false, n: 1, cents: 0 },
      ],
      "MXN"
    );
    expect(dto).toMatchObject({ bookingsDone: 6, withoutLead: 1, leads: 5, won: 4, rate: 0.8 });
    expect(dto.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 300000,
      otherCurrencies: [{ currency: "USD", amountCents: 5000, won: 1 }],
      wonWithoutAmount: 1,
    });
  });
});
