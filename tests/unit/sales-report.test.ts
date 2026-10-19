import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  NO_ADVISOR_LABEL,
  NO_LOSS_REASON,
  SALES_REPORT_SQL,
  funnelSql,
  salesReport,
  salesSummaryOf,
  shapeByAdvisor,
  shapeByDay,
  shapeFunnel,
  shapeLossReasons,
  shapeSalesFigures,
  shapeTimeToClose,
  type SalesReportParams,
} from "@/server/reports/sales";
import { parseReportRange } from "@/server/reports/range";
import type { ReportExec } from "@/server/reports/run";
import { LOSS_REASON_LABEL } from "@/lib/types";

/**
 * 021 — Reportes → Ventas: una venta se fecha por su ÚLTIMO evento `won`
 * (D1), se atribuye a quien la movió o al asignado de la conversación real
 * más reciente (D2), las monedas nunca se suman y un ganado sin evento queda
 * fuera de todo periodo. Más las reglas de todo reporte sobre el SQL
 * renderizado.
 */

const dialect = new PgDialect();
const P: SalesReportParams = {
  organizationId: "org_1",
  fromUtc: new Date("2026-09-17T06:00:00.000Z"),
  toUtc: new Date("2026-10-17T06:00:00.000Z"),
  tz: "America/Mexico_City",
};

const render = (q: SQL) => dialect.sqlToQuery(q);
const all = Object.entries(SALES_REPORT_SQL).map(
  ([name, build]) => [name, render((build as (p: SalesReportParams) => SQL)(P))] as const
);
const funnel = render(funnelSql(P, "MXN"));

describe("SQL", () => {
  it("tenant en todas, límites ::timestamp y nada de now()", () => {
    for (const [name, q] of all) {
      expect(q.params, name).toContain("org_1");
      expect(q.sql, name).toMatch(/"organization_id" = \$\d+/);
      expect(q.sql, name).not.toMatch(/now\(\)/i);
      expect(q.params, name).toContain("2026-09-17 06:00:00.000");
      expect(q.params, name).toContain("2026-10-17 06:00:00.000");
      expect(q.sql, name).toMatch(/\$\d+::timestamp/);
      // Nunca un Date (viajaría como timestamptz).
      expect(q.params.some((v) => v instanceof Date), name).toBe(false);
    }
  });

  it("el embudo es foto actual: tenant, sin now() y sin límites de rango", () => {
    expect(funnel.params).toContain("org_1");
    expect(funnel.sql).toMatch(/"pipeline_stage"."organization_id" = \$\d+/);
    expect(funnel.sql).not.toMatch(/now\(\)/i);
    expect(funnel.sql).not.toContain("::timestamp");
    expect(funnel.sql).toContain(`order by "pipeline_stage"."position" asc`);
    // Moneda principal como parámetro; Laboratorio en el ON (no se come etapas vacías).
    expect(funnel.params).toContain("MXN");
    const on = funnel.sql.slice(
      funnel.sql.indexOf("left join"),
      funnel.sql.indexOf(`\nwhere "pipeline_stage"`)
    );
    expect(on).toContain("lab.is_test = true");
    expect(funnel.sql.slice(funnel.sql.indexOf(`\nwhere "pipeline_stage"`))).not.toContain("lab.");
  });

  it("Laboratorio fuera con la misma regla que Anuncios", () => {
    for (const [name, q] of all) {
      expect(q.sql, name).toContain("lab.is_test = true");
      expect(q.sql, name).toContain("real_conv.is_test = false");
    }
  });

  it("D1: venta = HOY en won, fechada por su ÚLTIMO evento del mismo tipo (nunca updated_at)", () => {
    for (const [name, q] of all) {
      expect(q.sql, name).toContain(`"pipeline_stage"."kind" in ('won', 'lost')`);
      expect(q.sql, name).toContain(`ev1.to_stage_kind = "pipeline_stage"."kind"`);
      expect(q.sql, name).toContain("order by ev1.occurred_at desc, ev1.id desc");
      expect(q.sql, name).toContain("closed.closed_at >= $");
      expect(q.sql, name).not.toContain("updated_at");
    }
  });

  it("D2: actor del evento → asignado de la conversación real más reciente → sin asesor", () => {
    for (const [name, q] of all) {
      expect(q.sql, name).toMatch(
        /coalesce\(ev\.actor_user_id, \(\s*select rc\.assigned_user_id from "conversation" rc/
      );
      expect(q.sql, name).toContain("rc.is_test = false");
      expect(q.sql, name).toContain("order by rc.created_at desc, rc.id desc");
    }
    const adv = all.find(([n]) => n === "byAdvisorSql")![1];
    expect(adv.sql).toContain(`left join "user" u on u.id = closed.advisor_id`);
    expect(adv.sql).toContain("coalesce(nullif(u.name, ''), u.email)");
  });

  it("los ganados sin evento (sin fecha) se cuentan aparte, fuera del rango", () => {
    const q = all.find(([n]) => n === "salesSummarySql")![1];
    expect(q.sql).toContain("(closed_at is null) as no_date");
    expect(q.sql).toContain("(kind = 'won' and closed_at is null) or (");
  });

  it("la llegada es la de Anuncios: primer anuncio o alta del lead", () => {
    for (const [name, q] of all) {
      expect(q.sql, name).toContain(`coalesce(fa.arrived_at, "lead"."created_at") as arrived_at`);
    }
  });

  it("tiempo de cierre: sin fechas aproximadas, p50 y p75, nunca negativo", () => {
    const q = all.find(([n]) => n === "timeToCloseSql")![1];
    expect(q.sql).toContain("percentile_cont(0.5)");
    expect(q.sql).toContain("percentile_cont(0.75)");
    expect(q.sql).toContain("filter (where not approximate)");
    expect(q.sql).toContain("greatest(0, extract(epoch from closed_at - arrived_at))");
  });

  it("por día: la zona es un parámetro ligado, no texto interpolado", () => {
    const q = all.find(([n]) => n === "byDaySql")![1];
    expect(q.params).toContain("America/Mexico_City");
    expect(q.sql).not.toContain("America/Mexico_City");
    expect(q.sql).toMatch(/at time zone 'UTC'\) at time zone \$\d+/);
  });
});

describe("forma: resumen", () => {
  it("pliega montos por moneda, ticket promedio, tasa, aproximados y sin fecha", () => {
    const f = shapeSalesFigures(
      [
        { kind: "won", no_date: false, approximate: false, currency: "MXN", has_amount: true, n: "2", cents: "300000" },
        { kind: "won", no_date: false, approximate: true, currency: null, has_amount: true, n: 1, cents: 100000 },
        { kind: "won", no_date: false, approximate: false, currency: "USD", has_amount: true, n: 1, cents: 5000 },
        { kind: "won", no_date: false, approximate: false, currency: null, has_amount: false, n: 1, cents: 0 },
        { kind: "lost", no_date: false, approximate: false, currency: null, has_amount: false, n: "3", cents: 0 },
        { kind: "lost", no_date: false, approximate: true, currency: null, has_amount: false, n: 1, cents: 0 },
        { kind: "won", no_date: "t", approximate: false, currency: "MXN", has_amount: true, n: 2, cents: 999999 },
      ],
      "MXN"
    );
    expect(f.won).toBe(5);
    expect(f.lost).toBe(4);
    expect(f.closeRate).toBeCloseTo(5 / 9);
    expect(f.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 400000,
      otherCurrencies: [{ currency: "USD", amountCents: 5000, won: 1 }],
      wonWithoutAmount: 1,
    });
    // 3 ventas con monto en MXN (la USD y la sin monto no entran al ticket).
    expect(f.averageTicketCents).toBe(Math.round(400000 / 3));
    expect(f.approximateCount).toBe(2);
    // Los sin fecha NO suman a ventas ni a monto.
    expect(f.withoutDate).toBe(2);
  });

  it("sin cierres: tasa y ticket null (nunca NaN)", () => {
    const f = shapeSalesFigures([], "MXN");
    expect(f).toMatchObject({ won: 0, lost: 0, closeRate: null, averageTicketCents: null, withoutDate: 0 });
  });

  it("solo ventas en otra moneda: ticket principal null", () => {
    const f = shapeSalesFigures(
      [{ kind: "won", no_date: false, approximate: false, currency: "USD", has_amount: true, n: 2, cents: 5000 }],
      "MXN"
    );
    expect(f.averageTicketCents).toBeNull();
    expect(f.wonAmount.amountCents).toBe(0);
  });
});

describe("forma: asesor, motivos, embudo, tiempos, días", () => {
  it("por asesor: nombre o email, «Sin asesor» al final, monedas aparte", () => {
    const dto = shapeByAdvisor(
      [
        { advisor_id: "u_1", advisor_name: "Ana", kind: "won", currency: "MXN", has_amount: true, n: 1, cents: 1000 },
        { advisor_id: "u_1", advisor_name: "Ana", kind: "lost", currency: null, has_amount: false, n: 1, cents: 0 },
        { advisor_id: "u_2", advisor_name: "beto@x.mx", kind: "won", currency: "USD", has_amount: true, n: 2, cents: 7000 },
        { advisor_id: null, advisor_name: null, kind: "won", currency: null, has_amount: false, n: 5, cents: 0 },
      ],
      "MXN"
    );
    expect(dto.rows.map((r) => r.name)).toEqual(["beto@x.mx", "Ana", NO_ADVISOR_LABEL]);
    expect(dto.rows[1]).toMatchObject({ userId: "u_1", won: 1, lost: 1, closeRate: 0.5 });
    expect(dto.rows[0]!.wonAmount.otherCurrencies).toEqual([{ currency: "USD", amountCents: 7000, won: 2 }]);
    expect(dto.rows[2]).toMatchObject({ userId: null, won: 5, closeRate: 1 });
    expect(dto.rows[2]!.wonAmount.wonWithoutAmount).toBe(5);
  });

  it("motivos de pérdida: etiquetas del catálogo y «sin motivo» para las sembradas", () => {
    const dto = shapeLossReasons([
      { reason: "precio", n: "4" },
      { reason: null, n: 2 },
      { reason: "eligio_otro", n: 1 },
    ]);
    expect(dto.total).toBe(7);
    expect(dto.rows[0]).toEqual({ reason: "precio", label: LOSS_REASON_LABEL.precio, count: 4 });
    expect(dto.rows[1]).toMatchObject({ reason: NO_LOSS_REASON, count: 2 });
    expect(dto.rows[2]!.label).toBe(LOSS_REASON_LABEL.eligio_otro);
  });

  it("embudo: orden por posición, etapas vacías incluidas", () => {
    const dto = shapeFunnel(
      [
        { stage_id: "st_w", name: "Ganado", kind: "won", position: 9, leads: 2, cents: "500000", without_amount: 0, other_currency: 1 },
        { stage_id: "st_a", name: "Nuevo", kind: "open", position: 0, leads: "5", cents: 0, without_amount: 5, other_currency: 0 },
        { stage_id: "st_b", name: "Propuesta", kind: "open", position: 1, leads: 0, cents: 0, without_amount: 0, other_currency: 0 },
      ],
      "MXN"
    );
    expect(dto.stages.map((s) => s.stageId)).toEqual(["st_a", "st_b", "st_w"]);
    expect(dto.totalLeads).toBe(7);
    expect(dto.stages[2]).toMatchObject({ kind: "won", amountCents: 500000, leadsOtherCurrency: 1 });
  });

  it("tiempo de cierre en días; sin ventas medidas → null", () => {
    expect(shapeTimeToClose([{ sales: 3, approx: 1, p50_s: 172800, p75_s: "259200" }])).toEqual({
      sales: 3,
      excludedApproximate: 1,
      p50Days: 2,
      p75Days: 3,
    });
    expect(shapeTimeToClose([{ sales: 0, approx: 2, p50_s: null, p75_s: null }])).toEqual({
      sales: 0,
      excludedApproximate: 2,
      p50Days: null,
      p75Days: null,
    });
  });

  it("por día: todos los días del rango, monto solo en la principal", () => {
    const dto = shapeByDay(
      [
        { dia: "2026-10-02", currency: "MXN", has_amount: true, n: 1, cents: 1000 },
        { dia: "2026-10-02", currency: "USD", has_amount: true, n: 1, cents: 99 },
        { dia: "2026-10-03", currency: null, has_amount: false, n: 2, cents: 0 },
      ],
      ["2026-10-01", "2026-10-02", "2026-10-03"],
      "MXN"
    );
    expect(dto.rows).toEqual([
      { day: "2026-10-01", won: 0, amountCents: 0 },
      { day: "2026-10-02", won: 2, amountCents: 1000 },
      { day: "2026-10-03", won: 2, amountCents: 0 },
    ]);
  });
});

describe("ejecución", () => {
  const range = (() => {
    const r = parseReportRange({ range: "7d" }, "America/Mexico_City", new Date("2026-10-16T18:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    return r.range;
  })();

  it("summary trae el periodo anterior; withoutDate solo una vez", async () => {
    const seen: unknown[][] = [];
    const exec = (async (q: SQL) => {
      const { params } = dialect.sqlToQuery(q);
      seen.push(params);
      return [{ kind: "won", no_date: true, approximate: false, currency: null, has_amount: false, n: 1, cents: 0 }];
    }) as ReportExec;
    const dto = await salesSummaryOf(exec, "org_1", range, "MXN");
    expect(dto.withoutDate).toBe(1);
    expect(dto.previous).toMatchObject({ from: "2026-10-03", to: "2026-10-09", won: 0 });
    expect(dto.previous).not.toHaveProperty("withoutDate");
    expect(seen).toHaveLength(2);
  });

  it("un bloque que falla no tumba a los otros", async () => {
    const fake = async <T,>(fn: (exec: ReportExec) => Promise<T>) =>
      fn((async (q: SQL) => {
        if (dialect.sqlToQuery(q).sql.includes("percentile_cont")) throw new Error("boom");
        return [];
      }) as ReportExec);
    const dto = await salesReport("org_1", range, "MXN", {
      runReadOnly: fake,
      blocks: { onError: () => {} },
    });
    expect(dto.timeToClose).toEqual({ ok: false, error: "unavailable" });
    expect(dto.summary.ok && dto.summary.data.previous?.to).toBe("2026-10-09");
    expect(dto.byDay.ok && dto.byDay.data.rows).toHaveLength(7);
    expect(dto.funnel.ok && dto.funnel.data.currency).toBe("MXN");
    expect(dto.byAdvisor.ok).toBe(true);
    expect(dto.lossReasons.ok).toBe(true);
    expect(dto.range.days).toHaveLength(7);
  });
});
