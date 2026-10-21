import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  SELLERS_REPORT_SQL,
  funnelBySellerSql,
  sellersReport,
  shapeRoster,
  shapeSellerFunnel,
  shapeSellerSales,
} from "@/server/reports/sellers";
import { byAdvisorSql, shapeByAdvisor } from "@/server/reports/sales";
import { advisorFirstReplySql, pendingSql, personsSql, type SummaryReportParams } from "@/server/reports/summary";
import { bySellerSql } from "@/server/reports/bookings";
import { parseReportRange } from "@/server/reports/range";
import type { ReportExec } from "@/server/reports/run";

/**
 * 024 — Reportes → Vendedores: todos los miembros (también en cero) +
 * ex-miembros con datos + «Sin asignar»; cartera por responsable VIGENTE
 * sobre los MISMOS CTE del Resumen (la suma de filas da sus totales — se
 * verificó además contra Postgres real); ventas = Ventas → Por asesor tal
 * cual; citas solo con AGENDA.
 */

const dialect = new PgDialect();
const P: SummaryReportParams = {
  organizationId: "org_1",
  fromUtc: new Date("2026-10-01T06:00:00.000Z"),
  toUtc: new Date("2026-10-08T06:00:00.000Z"),
  tz: "America/Mexico_City",
};
const render = (q: SQL) => dialect.sqlToQuery(q);
const roster = render(SELLERS_REPORT_SQL.rosterSql(P));
const norm = (s: string) => s.replace(/\$\d+/g, "$?");

describe("SQL", () => {
  it("tenant, límites ::timestamp, nada de now(), nunca un Date", () => {
    for (const [name, q] of [
      ["rosterSql", roster],
      ["funnelBySellerSql", render(funnelBySellerSql(P, "MXN"))],
    ] as const) {
      expect(q.params, name).toContain("org_1");
      expect(q.sql, name).toMatch(/"organization_id" = \$\d+/);
      expect(q.sql, name).not.toMatch(/now\(\)|current_timestamp/i);
      expect(q.params.some((v) => v instanceof Date), name).toBe(false);
    }
    expect(roster.params).toContain("2026-10-01 06:00:00.000");
    expect(roster.params).toContain("2026-10-08 06:00:00.000");
    expect(roster.sql).toMatch(/\$\d+::timestamp/);
  });

  it("roster: los CTE del Resumen tal cual (personas, pendientes con tarjetas, tiempo hasta asesor)", () => {
    // Los placeholders ($n) cambian con la posición: se comparan sin número.
    const s = norm(roster.sql);
    // Las personas del Resumen y su versión con tarjetas, con los mismos cuerpos.
    const persons = norm(render(personsSql(P)).sql);
    const personsCte = persons.slice("with ".length, persons.indexOf("\nselect count(*)::int as persons"));
    expect(s).toContain(personsCte);
    expect(s).toContain("pin_all as (");
    expect(s).toContain("persons_all as (");
    const pend = norm(render(pendingSql(P)).sql);
    const pendCte = pend.slice(pend.indexOf("pend as ("), pend.indexOf("\nselect pend.conversation_id"));
    expect(s).toContain(pendCte.replace(/persons\./g, "persons_all.").replace("from persons\n", "from persons_all\n"));
    const fr = norm(render(advisorFirstReplySql(P)).sql);
    expect(s).toContain(fr.slice(fr.indexOf("fr as ("), fr.indexOf("\nselect count(*)::int as persons")));
    // Laboratorio fuera; responsable vigente; ex-miembros y «Sin asignar».
    expect(s).toContain(`"c"."is_test" = false`);
    expect(s).toContain(`"sc"."is_test" = false`);
    expect(s).toContain(`"sc"."assigned_user_id" as user_id`);
    expect(s).toContain("union select null::text");
    expect(s).toContain("s_conv.user_id is not distinct from k.user_id");
    expect(s).toContain(`"sc"."archived_at" is null`);
    expect(s).toContain("ss.kind = 'open'");
    expect(s).toContain("where ext.first_out_at is null");
  });

  it("embudo: responsable de la conversación REAL del contacto, Laboratorio fuera, moneda ligada", () => {
    const q = render(funnelBySellerSql(P, "MXN"));
    expect(q.sql).toContain(`"fc"."is_test" = false`);
    expect(q.sql).toContain("lab.is_test = true");
    expect(q.params).toContain("MXN");
  });
});

describe("forma", () => {
  it("roster: miembros (también en cero) por nombre, ex-miembros, «Sin asignar» siempre al final", () => {
    const dto = shapeRoster([
      { user_id: null, portfolio: 9, persons: 1, attended: 0, pending: 2, not_contacted: 1, fr_n: 0 },
      { user_id: "u_ex", name: "ex@x.mx", role: null, is_member: false, portfolio: 1, persons: 1, attended: 1, fr_n: 1, p50_s: "7200", p90_s: 7200 },
      { user_id: "u_beto", name: "Beto", role: "member", is_member: "t" },
      { user_id: "u_ana", name: "Ana", role: "member", is_member: true, portfolio: "2", assigned: 1, active: 1, persons: 2, attended: 1, pending: 1, fr_n: 1, p50_s: 1800, p90_s: 1800 },
    ]);
    expect(dto.rows.map((r) => r.name)).toEqual(["Ana", "Beto", "ex@x.mx", "Sin asignar"]);
    expect(dto.rows[0]).toMatchObject({ portfolio: 2, attendedRate: 0.5, advisorFirstReply: { persons: 1, p50Seconds: 1800 } });
    expect(dto.rows[1]).toMatchObject({ persons: 0, attendedRate: null, advisorFirstReply: { persons: 0, p50Seconds: null, p90Seconds: null } });
    expect(dto.rows[2]).toMatchObject({ isMember: false, role: null, advisorFirstReply: { p50Seconds: 7200 } });
    expect(dto.rows[3]).toMatchObject({ userId: null, role: null, isMember: false, pending: 2, externalNotContacted: 1 });
    expect(dto.totals).toEqual({
      portfolio: 12,
      assignedInRange: 1,
      activePortfolio: 1,
      persons: 4,
      attended: 2,
      attendedRate: 0.5,
      pending: 3,
      externalNotContacted: 1,
    });
    // Sin filas: «Sin asignar» igual.
    expect(shapeRoster([]).rows.map((r) => r.name)).toEqual(["Sin asignar"]);
  });

  it("ventas: Ventas → Por asesor tal cual + ticket promedio en la moneda principal", () => {
    const rows = [
      { advisor_id: "u_ana", advisor_name: "Ana", kind: "won", currency: "MXN", has_amount: true, n: 2, cents: "300000" },
      { advisor_id: "u_ana", advisor_name: "Ana", kind: "won", currency: null, has_amount: false, n: 1, cents: 0 },
      { advisor_id: null, advisor_name: null, kind: "lost", currency: null, has_amount: false, n: 1, cents: 0 },
    ];
    const dto = shapeSellerSales(rows, "MXN");
    const base = shapeByAdvisor(rows, "MXN");
    expect(dto.rows.map(({ averageTicketCents: _t, ...r }) => r)).toEqual(base.rows);
    expect(dto.rows.map((r) => r.averageTicketCents)).toEqual([150000, null]);
  });

  it("embudo: celdas en el orden de las etapas; abiertos solo de etapas open; «Sin asignar» al final", () => {
    const stages = [
      { stage_id: "st_new", name: "Nuevo", kind: "open", position: 0, leads: 3, cents: 0 },
      { stage_id: "st_won", name: "Ganado", kind: "won", position: 2, leads: 1, cents: 100000 },
    ];
    const dto = shapeSellerFunnel(
      stages,
      [
        { user_id: null, stage_id: "st_new", leads: 2, cents: 0 },
        { user_id: "u_ana", name: "Ana", stage_id: "st_won", leads: 1, cents: "100000" },
        { user_id: "u_ana", name: "Ana", stage_id: "st_new", leads: 1, cents: 5000 },
      ],
      "MXN"
    );
    expect(dto.stages.map((s) => s.stageId)).toEqual(["st_new", "st_won"]);
    expect(dto.rows.map((r) => r.name)).toEqual(["Ana", "Sin asignar"]);
    expect(dto.rows[0]).toMatchObject({
      openLeads: 1,
      openAmountCents: 5000,
      cells: [
        { stageId: "st_new", leads: 1, amountCents: 5000 },
        { stageId: "st_won", leads: 1, amountCents: 100000 },
      ],
    });
  });
});

describe("ejecución", () => {
  const range = (() => {
    const r = parseReportRange({ range: "7d" }, "America/Mexico_City", new Date("2026-10-21T18:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    return r.range;
  })();
  const fakeRun = (seen: string[], fail?: (s: string) => boolean) =>
    async <T,>(fn: (exec: ReportExec) => Promise<T>) =>
      fn((async (query: SQL) => {
        const s = dialect.sqlToQuery(query).sql;
        seen.push(s);
        if (fail?.(s)) throw new Error("boom");
        return [];
      }) as ReportExec);

  it("AGENDA apagada: sin bloque de citas (ni se consulta booking)", async () => {
    const seen: string[] = [];
    const dto = await sellersReport("org_1", range, "MXN", {
      runReadOnly: fakeRun(seen),
      now: () => new Date("2026-10-21T18:00:00Z"),
      agendaEnabled: () => false,
    });
    expect(dto.agendaEnabled).toBe(false);
    expect(dto.bookings).toBeNull();
    expect(seen.some((s) => s.includes(`"booking"`))).toBe(false);
    expect(dto.roster.ok && dto.roster.data.rows.map((r) => r.name)).toEqual(["Sin asignar"]);
    expect(dto.sales).toEqual({ ok: true, data: { rows: [] } });
    expect(dto.funnel.ok && dto.funnel.data).toEqual({ currency: "MXN", stages: [], rows: [] });
    expect(dto.range.preset).toBe("7d");
  });

  it("AGENDA encendida: citas = Citas → Por vendedor; ventas = byAdvisorSql; un bloque caído no tumba a los otros", async () => {
    const seen: string[] = [];
    const p = { organizationId: "org_1", fromUtc: range.fromUtc, toUtc: range.toUtc, tz: range.tz };
    const advisor = dialect.sqlToQuery(byAdvisorSql(p)).sql;
    const now = new Date("2026-10-21T18:00:00Z");
    const seller = dialect.sqlToQuery(bySellerSql({ ...p, now })).sql;
    const dto = await sellersReport("org_1", range, "MXN", {
      runReadOnly: fakeRun(seen, (s) => s.includes("s_active as (")),
      now: () => now,
      agendaEnabled: () => true,
      blocks: { onError: () => {} },
    });
    expect(dto.agendaEnabled).toBe(true);
    expect(dto.roster).toEqual({ ok: false, error: "unavailable" });
    expect(seen).toContain(advisor);
    expect(seen).toContain(seller);
    expect(dto.bookings?.ok && dto.bookings.data.rows.map((r) => r.name)).toEqual(["Sin vendedor"]);
    expect(dto.sales.ok).toBe(true);
  });
});
