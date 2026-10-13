import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  BOOKING_REPORT_SQL,
  bookingReport,
  shapeAttendance,
  shapeByReminder,
  shapeOffers,
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
    expect(shapeAttendance([{ realizada: 3, no_show: 1, pending_to_mark: 2, cancelada: 5 }])).toEqual({
      realizada: 3,
      noShow: 1,
      rate: 0.75,
      pendingToMark: 2,
      cancelada: 5,
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
  it("tres bloques con el rango; uno caído no tumba los demás", async () => {
    const parsed = parseReportRange({ range: "30d" }, "America/Mexico_City", P.now);
    if (!parsed.ok) throw new Error(parsed.message);
    let i = 0;
    const report = await bookingReport("org_1", parsed.range, P.now, {
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
  });
});
