import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  SUMMARY_REPORT_SQL,
  shapeAttentionFigures,
  shapeExternalLeads,
  shapePending,
  shapeSummaryByChannel,
  shapeSummaryByHour,
  shapeSummaryByOrigin,
  shapeTeam,
  teamSql,
  summaryReport,
  type SummaryReportParams,
} from "@/server/reports/summary";
import { responseTimesSql } from "@/server/reports/agent";
import { parseReportRange } from "@/server/reports/range";
import type { ReportExec } from "@/server/reports/run";
import { ADS_REPORT_MAX_ROWS, SUMMARY_PENDING_MAX_ROWS, SUMMARY_TEAM_MAX_ROWS } from "@/lib/reports";
import { attendanceSql } from "@/server/reports/bookings";
import { LEAD_INTAKE_HEADER } from "@/lib/lead-intake";

/**
 * 021 — Reportes → Resumen para dirección: persona = conversación real con
 * entrantes en el rango; contestada / atendida por asesor según el primer
 * entrante; por anuncio con las ventas del periodo; por hora con la zona
 * como parámetro; pendientes; y Ventas + tiempos de Agente reutilizados.
 */

const dialect = new PgDialect();
const P: SummaryReportParams = {
  organizationId: "org_1",
  fromUtc: new Date("2026-10-16T06:00:00.000Z"),
  toUtc: new Date("2026-10-17T06:00:00.000Z"),
  tz: "America/Mexico_City",
};

const all = Object.entries(SUMMARY_REPORT_SQL).map(
  ([name, build]) => [name, dialect.sqlToQuery((build as (p: SummaryReportParams) => SQL)(P))] as const
);
const q = (name: keyof typeof SUMMARY_REPORT_SQL) => all.find(([n]) => n === name)![1];

describe("SQL", () => {
  it("tenant en todas, límites ::timestamp y nada de now()", () => {
    for (const [name, query] of all) {
      expect(query.params, name).toContain("org_1");
      expect(query.sql, name).toMatch(/"organization_id" = \$\d+/);
      expect(query.sql, name).not.toMatch(/now\(\)/i);
      expect(query.params, name).toContain("2026-10-16 06:00:00.000");
      expect(query.params, name).toContain("2026-10-17 06:00:00.000");
      expect(query.sql, name).toMatch(/\$\d+::timestamp/);
      expect(query.params.some((v) => v instanceof Date), name).toBe(false);
    }
  });

  it("Laboratorio fuera: conversaciones is_test (y la regla de contacto en ventas)", () => {
    for (const [name, query] of all) {
      expect(query.sql, name).toContain(`"c"."is_test" = false`);
    }
    expect(q("salesByOriginSql").sql).toContain("lab.is_test = true");
    expect(q("salesByOriginSql").sql).toContain("real_conv.is_test = false");
  });

  it("persona = conversación con entrantes del rango; contestada/atendida tras el PRIMER entrante", () => {
    const s = q("personsSql").sql;
    expect(s).toContain(`min("m"."created_at") as first_in_at`);
    expect(s).toContain(`"m"."direction" = 'in'`);
    expect(s).toContain("rr.direction = 'out' and rr.status <> 'failed'");
    expect(s).toContain("rr.created_at > pin.first_in_at");
    expect(s).toContain("rr.origin in ('operator', 'manual')");
  });

  it("021: primera respuesta de asesor desde el PRIMER entrante, aunque antes contestara la IA", () => {
    const s = q("advisorFirstReplySql").sql;
    expect(s).toContain("min(rr.created_at) - persons.first_in_at");
    expect(s).toContain("rr.origin in ('operator', 'manual')");
    // En el MISMO join del asesor (personsCte también trae estas condiciones).
    expect(s).toContain(
      "rr.direction = 'out' and rr.status <> 'failed'\n    and rr.origin in ('operator', 'manual')"
    );
    expect(s).toContain("rr.created_at > persons.first_in_at");
    expect(s).toContain("percentile_cont(0.5) within group (order by secs)");
    // No exige que el asesor haya sido el primero: ninguna condición sobre la IA.
    expect(s).not.toMatch(/origin\s*=\s*'ai'/);
  });

  it("enviados: salientes fallidos fuera, por origen", () => {
    const s = q("messagesSql").sql;
    expect(s).toContain(`("m"."direction" = 'in' or "m"."status" <> 'failed')`);
    expect(s).toContain(`"m"."origin" as origin`);
  });

  it("pasadas a asesor: bitácora de escalamientos, sin manual_reply", () => {
    const s = q("handedOffSql").sql;
    expect(s).toContain(`"e"."kind" = 'opened'`);
    expect(s).toContain(`"e"."reason" is distinct from 'manual_reply'`);
    expect(s).not.toContain("handoff_at");
  });

  it("021b por origen: primer anuncio y primera tarjeta del contacto; ventas por el origen del lead", () => {
    for (const name of ["leadsByOriginSql", "salesByOriginSql"] as const) {
      const s = q(name).sql;
      expect(s, name).toContain("case when origin = 'ad' then coalesce(source_id, attribution_id) end as ad_key");
      expect(s, name).toContain(
        `order by "ad_attribution"."contact_id", "ad_attribution"."created_at" asc, "ad_attribution"."id" asc`
      );
      // Primera tarjeta histórica (sin límites de rango), mismo orden que `fa`.
      const start = s.indexOf("fc as (");
      const fc = s.slice(start, s.indexOf(`"m"."id" asc`, start) + `"m"."id" asc`.length);
      expect(fc, name).toContain(`"m"."type" = 'lead_intake'`);
      expect(fc, name).toContain(`order by "c"."contact_id", "m"."created_at" asc, "m"."id" asc`);
      expect(fc, name).not.toContain("::timestamp");
      // Empate entre anuncio y tarjeta → el anuncio.
      expect(s, name).toContain("(fc.first_card_at is null or fa.arrived_at <= fc.first_card_at) then 'ad'");
      expect(s, name).toContain("when fc.first_card_at is not null then fc.card_origin");
    }
    const sales = q("salesByOriginSql").sql;
    expect(sales).toContain("closed.kind = 'won'");
    expect(sales).toContain("order by ev1.occurred_at desc, ev1.id desc");
  });

  it("021b: la cabecera de la tarjeta viaja como parámetro ligado, nunca como texto", () => {
    for (const name of ["leadsByOriginSql", "salesByOriginSql", "externalLeadsSql"] as const) {
      const query = q(name);
      for (const [key, header] of Object.entries(LEAD_INTAKE_HEADER)) {
        expect(query.params, name).toContain(header);
        expect(query.sql, name).not.toContain(header);
        expect(query.sql, name).toMatch(new RegExp(`when \\$\\d+ then '${key}'`));
      }
      expect(query.sql, name).toContain("btrim(split_part(replace(");
    }
  });

  it("021b lead = escribió O recibió tarjeta en el rango; contactado tras su PRIMER toque, a nivel contacto", () => {
    const s = q("leadsByOriginSql").sql;
    const lt = s.slice(s.indexOf("lt as ("), s.indexOf("), leads as ("));
    // Las tarjetas SÍ hacen lead: el WHERE no las excluye, solo el conteo de mensajes.
    expect(lt).toContain(`"m"."direction" = 'in'`);
    expect(lt).toContain(`(count(*) filter (where "m"."type" <> 'lead_intake'))::int as inbound`);
    expect(lt.slice(lt.indexOf("\n  where"))).not.toContain("lead_intake");
    expect(s).toContain("min(lt.first_at) as first_at");
    expect(s).toContain("(count(*) filter (where lt.inbound > 0))::int as wrote");
    // Contacto: cualquier conversación REAL del contacto, salientes no fallidos.
    expect(s).toContain("rc.contact_id = leads.contact_id and rc.is_test = false");
    expect(s).toContain("rr.direction = 'out' and rr.status <> 'failed'");
    expect(s).toContain("rr.created_at > leads.first_at");
    expect(s).toContain("rr.origin in ('operator', 'manual')");
    // KPI «Leads nuevos»: la misma unidad.
    expect(q("leadsSql").sql).toContain("(count(*) filter (where is_new))::int as new_leads");
  });

  it("021b leads externos: primera tarjeta del rango por contacto y origen; respondió = entrante no tarjeta posterior", () => {
    const s = q("externalLeadsSql").sql;
    expect(s).toContain(`"m"."type" = 'lead_intake'`);
    expect(s).toContain("distinct on (contact_id, origin)");
    expect(s).toContain("order by contact_id, origin, card_at asc, id asc");
    expect(s).toContain("where origin is not null");
    expect(s).toContain("rr.direction = 'in'");
    expect(s).toContain("rr.type <> 'lead_intake'");
    expect(s).toContain("rr.created_at > cards.card_at");
    expect(s).toContain("count(first_out_at)::int as contacted");
    expect(s).toContain(
      "percentile_cont(0.9) within group (order by extract(epoch from (first_out_at - card_at))) filter (where first_out_at is not null)"
    );
  });

  it("por hora: la zona es un parámetro ligado, nunca texto interpolado", () => {
    const query = q("byHourSql");
    expect(query.params).toContain("America/Mexico_City");
    expect(query.sql).not.toContain("America/Mexico_City");
    expect(query.sql).toMatch(/extract\(hour from \(\("m"\."created_at" at time zone 'UTC'\) at time zone \$\d+\)\)/);
  });

  it("pendientes: sin saliente posterior al ÚLTIMO entrante, el más antiguo primero, tope 20", () => {
    const query = q("pendingSql");
    expect(query.sql).toContain("max(li1.created_at) as last_in_at");
    expect(query.sql).toMatch(/where not exists \(\s*select 1 from "message" rr/);
    expect(query.sql).toContain("rr.created_at > li.last_in_at");
    expect(query.sql).toContain("(count(*) over ())::int as total");
    expect(query.sql).toContain("order by pend.last_in_at asc, pend.conversation_id asc");
    expect(query.params).toContain(SUMMARY_PENDING_MAX_ROWS);
  });

  // 011: la tarjeta de un lead externo es un entrante que no escribió el
  // cliente (mismo criterio que agent-report-sql).
  const NOT_INTAKE = `"m"."type" <> 'lead_intake'`;

  it.each([
    "personsSql",
    "messagesSql",
    "byHourSql",
    "advisorFirstReplySql",
    "byChannelSql",
  ] as const)("011: %s deja fuera las tarjetas de leads externos", (name) => {
    expect(q(name).sql).toContain(NOT_INTAKE);
  });

  it("011: el reloj del asesor arranca en el primer entrante que NO es tarjeta", () => {
    const s = q("advisorFirstReplySql").sql;
    const pin = s.slice(s.indexOf("pin as ("), s.indexOf("), persons as ("));
    expect(pin).toContain("min(\"m\".\"created_at\") as first_in_at");
    expect(pin).toContain(NOT_INTAKE);
  });

  it("011: pendientes SÍ cuentan las tarjetas (un lead sin atender está pendiente)", () => {
    const s = q("pendingSql").sql;
    expect(s).not.toContain("lead_intake");
    expect(s).toContain(`"m"."direction" = 'in'`);
  });
});

describe("forma", () => {
  it("atención: mensajes por origen, tasas null sin personas", () => {
    const f = shapeAttentionFigures(
      [
        { direction: "in", origin: "operator", n: "12" },
        { direction: "out", origin: "ai", n: 7 },
        { direction: "out", origin: "operator", n: 2 },
        { direction: "out", origin: "manual", n: 1 },
        { direction: "out", origin: "template", n: 3 },
      ],
      [{ persons: "4", new_persons: 1, answered: 3, by_advisor: "2" }],
      [{ n: 1 }]
    );
    expect(f).toEqual({
      inbound: 12,
      outbound: 13,
      outboundByOrigin: { ai: 7, advisor: 3, template: 3 },
      persons: 4,
      newPersons: 1,
      answered: 3,
      answeredRate: 0.75,
      attendedByAdvisor: 2,
      attendedByAdvisorRate: 0.5,
      handedOff: 1,
      advisorFirstReply: { persons: 0, p50Seconds: null, p90Seconds: null },
      leads: 0,
      newLeads: 0,
    });
    const empty = shapeAttentionFigures([], [], []);
    expect(empty).toMatchObject({ persons: 0, answeredRate: null, attendedByAdvisorRate: null, handedOff: 0 });
  });

  it("021b: KPI «Leads nuevos» con el total de leads", () => {
    const f = shapeAttentionFigures([], [], [], [], [{ leads: "7", new_leads: 3 }]);
    expect(f).toMatchObject({ leads: 7, newLeads: 3, persons: 0 });
  });

  it("021: tiempo hasta que atiende un asesor, null sin personas atendidas", () => {
    const f = shapeAttentionFigures([], [], [], [{ persons: "3", p50_s: "1020.5", p90_s: 3600 }]);
    expect(f.advisorFirstReply).toEqual({ persons: 3, p50Seconds: 1020.5, p90Seconds: 3600 });
    const none = shapeAttentionFigures([], [], [], [{ persons: 0, p50_s: null, p90_s: null }]);
    expect(none.advisorFirstReply).toEqual({ persons: 0, p50Seconds: null, p90Seconds: null });
  });

  const lead = (o: Record<string, unknown>) => ({
    origin: null, ad_key: null, source_id: null, source_type: null, headline: null,
    leads: 0, new_leads: 0, wrote: 0, inbound: 0, contacted: 0, by_advisor: 0, ...o,
  });
  const sale = (o: Record<string, unknown>) => ({
    origin: null, ad_key: null, source_id: null, source_type: null, headline: null,
    currency: null, has_amount: true, n: 1, cents: 0, ...o,
  });

  it("021b por origen: anuncios, sitio web, FastApp y sin origen; monedas nunca sumadas", () => {
    const dto = shapeSummaryByOrigin(
      [
        lead({ origin: "ad", ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", leads: 3, new_leads: 2, wrote: 3, inbound: 9, contacted: 3, by_advisor: 1 }),
        lead({ leads: "5", wrote: 5, inbound: 6, contacted: 4 }),
        lead({ origin: "ad", ad_key: "at_x", source_type: "post", leads: 1, new_leads: 1, wrote: 1, inbound: 1 }),
        lead({ origin: "website", leads: 4, new_leads: 4, wrote: 1, inbound: 2, contacted: 2, by_advisor: 1 }),
        lead({ origin: "fast_app", leads: 2, new_leads: 1, contacted: 1 }),
        // Cabecera desconocida o un 'ad' sin clave → sin origen.
        lead({ origin: "otro", leads: 1 }),
        lead({ origin: "ad", ad_key: null, leads: 1 }),
      ],
      [
        sale({ origin: "ad", ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", currency: "MXN", cents: 50000 }),
        sale({ origin: "ad", ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", currency: "USD", cents: 900 }),
        // Venta de un anuncio sin leads en el rango: también sale.
        sale({ origin: "ad", ad_key: "AD9", source_id: "AD9", source_type: "ad", has_amount: false, n: 2 }),
        sale({ cents: 1000 }),
        sale({ origin: "website", currency: "MXN", cents: 30000 }),
        sale({ origin: "fast_app", has_amount: false }),
      ],
      "MXN"
    );
    expect(dto.total).toBe(3);
    expect(dto.rows.map((r) => r.key)).toEqual(["AD1", "at_x", "AD9"]);
    expect(dto.rows[0]).toMatchObject({ title: "Kit", leads: 3, newLeads: 2, wrote: 3, inbound: 9, contacted: 3, won: 2 });
    expect(dto.rows[0]!.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 50000,
      otherCurrencies: [{ currency: "USD", amountCents: 900, won: 1 }],
      wonWithoutAmount: 0,
    });
    expect(dto.rows[1]!.title).toBe("Publicación sin título");
    expect(dto.rows[2]).toMatchObject({ title: "Anuncio sin título", leads: 0, won: 2 });
    expect(dto.website).toMatchObject({ leads: 4, newLeads: 4, wrote: 1, contacted: 2, attendedByAdvisor: 1, won: 1 });
    expect(dto.website.wonAmount.amountCents).toBe(30000);
    expect(dto.fastApp).toMatchObject({ leads: 2, contacted: 1, won: 1 });
    expect(dto.fastApp.wonAmount.wonWithoutAmount).toBe(1);
    expect(dto.unidentified).toMatchObject({ leads: 7, wrote: 5, inbound: 6, contacted: 4, won: 1 });
    expect(dto.unidentified.wonAmount.amountCents).toBe(1000);
    // Total = TODOS los grupos.
    expect(dto.totals).toMatchObject({ leads: 17, newLeads: 8, wrote: 10, inbound: 18, contacted: 10, attendedByAdvisor: 2, won: 7 });
    expect(dto.totals.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 81000,
      otherCurrencies: [{ currency: "USD", amountCents: 900, won: 1 }],
      wonWithoutAmount: 3,
    });
  });

  it("021b por origen: tope de filas de anuncios, total y totales completos", () => {
    const rows = Array.from({ length: ADS_REPORT_MAX_ROWS + 5 }, (_, i) =>
      lead({ origin: "ad", ad_key: `AD${i}`, source_id: `AD${i}`, leads: i + 1, inbound: 1 })
    );
    const dto = shapeSummaryByOrigin(rows, [], "MXN");
    expect(dto.rows).toHaveLength(ADS_REPORT_MAX_ROWS);
    expect(dto.total).toBe(ADS_REPORT_MAX_ROWS + 5);
    expect(dto.rows[0]!.leads).toBe(ADS_REPORT_MAX_ROWS + 5);
    const n = ADS_REPORT_MAX_ROWS + 5;
    expect(dto.totals.leads).toBe((n * (n + 1)) / 2);
    expect(dto.totals.inbound).toBe(n);
  });

  it("021b leads externos: siempre Sitio web y FastApp; sin contactar = recibidos − contactados", () => {
    expect(shapeExternalLeads([]).rows).toEqual([
      { origin: "website", label: "Sitio web", received: 0, contacted: 0, notContacted: 0, replied: 0, firstContact: { measured: 0, p50Seconds: null, p90Seconds: null } },
      { origin: "fast_app", label: "FastApp (promotores)", received: 0, contacted: 0, notContacted: 0, replied: 0, firstContact: { measured: 0, p50Seconds: null, p90Seconds: null } },
    ]);
    const dto = shapeExternalLeads([
      { origin: "fast_app", received: "3", contacted: 1, replied: 0, p50_s: "120.5", p90_s: 300 },
      { origin: "website", received: 4, contacted: 0, replied: 1, p50_s: null, p90_s: null },
      { origin: "otro", received: 9, contacted: 9 },
    ]);
    expect(dto.rows.map((r) => r.origin)).toEqual(["website", "fast_app"]);
    expect(dto.rows[0]).toMatchObject({ received: 4, contacted: 0, notContacted: 4, replied: 1, firstContact: { measured: 0, p50Seconds: null } });
    expect(dto.rows[1]).toMatchObject({ received: 3, contacted: 1, notContacted: 2, firstContact: { measured: 1, p50Seconds: 120.5, p90Seconds: 300 } });
  });

  it("por canal: WhatsApp siempre, orden fijo, canales desconocidos fuera", () => {
    expect(shapeSummaryByChannel([]).rows).toEqual([
      { channel: "whatsapp", persons: 0, inbound: 0, answered: 0, attendedByAdvisor: 0 },
    ]);
    const dto = shapeSummaryByChannel([
      { channel: "messenger", persons: 1, inbound: 2, answered: 1, by_advisor: 0 },
      { channel: "fax", persons: 9, inbound: 9, answered: 9, by_advisor: 9 },
      { channel: "instagram", persons: 2, inbound: 3, answered: 2, by_advisor: 1 },
    ]);
    expect(dto.rows.map((r) => r.channel)).toEqual(["whatsapp", "instagram", "messenger"]);
  });

  it("por hora: siempre 24 filas", () => {
    const dto = shapeSummaryByHour([{ hora: 9, n: "4" }, { hora: "23", n: 1 }, { hora: 24, n: 5 }]);
    expect(dto.rows).toHaveLength(24);
    expect(dto.rows[9]).toEqual({ hour: 9, inbound: 4 });
    expect(dto.rows[23]).toEqual({ hour: 23, inbound: 1 });
    expect(dto.rows.reduce((a, r) => a + r.inbound, 0)).toBe(5);
  });

  it("pendientes: anuncio con titular, total aparte de las filas", () => {
    const dto = shapePending([
      { conversation_id: "cv_1", contact_id: "ct_1", channel: "whatsapp", contact_name: "Luis", last_in_at: "2026-10-16T15:00:00.000Z", has_ad: true, headline: "Kit", source_type: "ad", total: 31 },
      { conversation_id: "cv_2", contact_id: "ct_2", channel: "instagram", contact_name: "", last_in_at: "2026-10-16T16:00:00.000Z", has_ad: false, headline: null, source_type: null, total: 31 },
    ]);
    expect(dto.total).toBe(31);
    expect(dto.rows[0]).toEqual({
      conversationId: "cv_1",
      contactId: "ct_1",
      contactName: "Luis",
      channel: "whatsapp",
      adTitle: "Kit",
      lastInboundAt: "2026-10-16T15:00:00.000Z",
    });
    expect(dto.rows[1]).toMatchObject({ contactName: null, adTitle: null });
    expect(shapePending([])).toEqual({ total: 0, rows: [] });
  });
});

describe("ejecución", () => {
  const range = (() => {
    const r = parseReportRange({ range: "today" }, "America/Mexico_City", new Date("2026-10-16T18:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    return r.range;
  })();

  it("reutiliza M4 de Agente tal cual y el resumen de Ventas; un bloque caído no tumba a los otros", async () => {
    const m4 = dialect.sqlToQuery(
      responseTimesSql({ organizationId: "org_1", fromUtc: range.fromUtc, toUtc: range.toUtc, tz: range.tz, now: new Date(0) })
    ).sql;
    const seen: string[] = [];
    const fake = async <T,>(fn: (exec: ReportExec) => Promise<T>) =>
      fn((async (query: SQL) => {
        const s = dialect.sqlToQuery(query).sql;
        seen.push(s);
        if (s.includes("extract(hour")) throw new Error("boom");
        if (s === m4) return [{ quien: "ia", sesiones: 2, p50_s: 30, p90_s: 60 }];
        return [];
      }) as ReportExec);
    const dto = await summaryReport("org_1", range, "MXN", {
      runReadOnly: fake,
      now: () => new Date("2026-10-16T18:00:00Z"),
      blocks: { onError: () => {} },
      intakeEnabled: () => true,
    });
    expect(dto.byHour).toEqual({ ok: false, error: "unavailable" });
    expect(seen).toContain(m4);
    expect(dto.responseTimes.ok && dto.responseTimes.data.ai).toEqual({
      sessions: 2,
      p50Seconds: 30,
      p90Seconds: 60,
    });
    expect(dto.attention.ok && dto.attention.data.previous).toMatchObject({
      from: "2026-10-15",
      to: "2026-10-15",
      persons: 0,
    });
    expect(dto.sales.ok && dto.sales.data.previous?.to).toBe("2026-10-15");
    expect(dto.byOrigin.ok && dto.byOrigin.data).toMatchObject({ rows: [], total: 0, totals: { leads: 0 } });
    expect(dto.external.ok && dto.external.data.rows.map((r) => r.received)).toEqual([0, 0]);
    expect(dto.attention.ok && dto.attention.data).toMatchObject({ leads: 0, newLeads: 0 });
    expect(dto.intakeEnabled).toBe(true);
    expect(dto.byChannel.ok).toBe(true);
    expect(dto.pending.ok && dto.pending.data).toEqual({ total: 0, rows: [] });
    expect(dto.range.preset).toBe("today");
  });
});

describe("024 — Equipo y citas del periodo", () => {
  const on = dialect.sqlToQuery(teamSql(P, { currency: "MXN", agenda: true }));
  const off = dialect.sqlToQuery(teamSql(P, { currency: "MXN", agenda: false }));

  it("SQL: UNA consulta con tenant, límites ::timestamp, Laboratorio fuera y nada de now()", () => {
    for (const [name, q] of [["on", on], ["off", off]] as const) {
      expect(q.params, name).toContain("org_1");
      expect(q.sql, name).toMatch(/"organization_id" = \$\d+/);
      expect(q.sql, name).not.toMatch(/now\(\)|current_timestamp/i);
      expect(q.params, name).toContain("2026-10-16 06:00:00.000");
      expect(q.params, name).toContain("2026-10-17 06:00:00.000");
      expect(q.params.some((v) => v instanceof Date), name).toBe(false);
      expect(q.sql, name).toContain(`"c"."is_test" = false`);
      expect(q.sql, name).toContain("lab.is_test = true"); // ventas: regla de contacto
      expect(q.sql.match(/^with /gm), name).toHaveLength(1);
      // Pendientes CON tarjetas; atendidas SIN ellas (las del Resumen).
      expect(q.sql, name).toContain("persons_all as (");
      expect(q.sql, name).toContain("from persons_all\n");
      // Ventas D1 + D2 en la moneda principal (parámetro ligado).
      expect(q.sql, name).toContain("closed.kind = 'won'");
      expect(q.params, name).toContain("MXN");
    }
    expect(on.sql).toContain(`"booking"."kind" = 'session'`);
    expect(on.sql).toContain(`"booking"."is_test" = false`);
    expect(on.sql).toContain(`"booking"."status" = 'realizada'`);
    expect(off.sql).not.toContain(`"booking"`);
    expect(off.sql).toContain("null::int as bookings_done");
  });

  it("forma: tope de filas + «Otros», «Sin asignar» aparte, totales y el que concentra pendientes", () => {
    const sellers = Array.from({ length: SUMMARY_TEAM_MAX_ROWS + 2 }, (_, i) => ({
      user_id: `u_${String(i).padStart(2, "0")}`,
      name: `V${String(i).padStart(2, "0")}`,
      assigned: 1,
      pending: i === 11 ? 7 : 0,
      attended: 1,
      won: i < 3 ? 3 - i : 0,
      cents: i < 3 ? String((3 - i) * 1000) : 0,
      bookings_done: 1,
    }));
    const dto = shapeTeam([...sellers, { user_id: null, pending: 3, attended: 0, won: 1, cents: 0 }], "MXN", true);
    expect(dto.rows).toHaveLength(SUMMARY_TEAM_MAX_ROWS);
    expect(dto.rows.slice(0, 3).map((r) => r.name)).toEqual(["V00", "V01", "V02"]);
    // Sin ventas, el de más pendientes va primero.
    expect(dto.rows[3]!.name).toBe("V11");
    expect(dto.others).toMatchObject({ sellers: 2, assignedInRange: 2, attended: 2, bookingsDone: 2 });
    expect(dto.unassigned).toMatchObject({ userId: null, name: "Sin asignar", pending: 3, won: 1, bookingsDone: 0 });
    expect(dto.totals).toEqual({
      assignedInRange: 12,
      pending: 10,
      attended: 12,
      bookingsDone: 12,
      won: 7,
      wonAmountCents: 6000,
    });
    expect(dto.topPending).toEqual({ userId: "u_11", name: "V11", pending: 7, ofTotal: 10 });
    // Sin AGENDA: columna de citas null; nadie con pendientes → sin viñeta.
    const off = shapeTeam([{ user_id: "u_1", name: "Ana", bookings_done: null }], "MXN", false);
    expect(off.rows[0]!.bookingsDone).toBeNull();
    expect(off.totals.bookingsDone).toBeNull();
    expect(off.unassigned.bookingsDone).toBeNull();
    expect(off.others).toBeNull();
    expect(off.topPending).toBeNull();
  });

  it("ejecución: AGENDA apagada no consulta citas; encendida reutiliza la asistencia de Citas", async () => {
    const range = (() => {
      const r = parseReportRange({ range: "today" }, "America/Mexico_City", new Date("2026-10-16T18:00:00Z"));
      if (!r.ok) throw new Error(r.message);
      return r.range;
    })();
    const now = new Date("2026-10-16T18:00:00Z");
    const att = dialect.sqlToQuery(
      attendanceSql({ organizationId: "org_1", fromUtc: range.fromUtc, toUtc: range.toUtc, now })
    ).sql;
    const run = (seen: string[]) =>
      async <T,>(fn: (exec: ReportExec) => Promise<T>) =>
        fn((async (query: SQL) => {
          const s = dialect.sqlToQuery(query).sql;
          seen.push(s);
          if (s === att) return [{ total: 5, agendada: 1, realizada: 3, no_show: 1, cancelada: 0, pending_to_mark: 0 }];
          return [];
        }) as ReportExec);
    const seenOff: string[] = [];
    const offDto = await summaryReport("org_1", range, "MXN", {
      runReadOnly: run(seenOff),
      now: () => now,
      intakeEnabled: () => false,
      agendaEnabled: () => false,
    });
    expect(offDto.agendaEnabled).toBe(false);
    expect(offDto.bookings).toBeNull();
    expect(seenOff.some((s) => s.includes(`"booking"`))).toBe(false);
    expect(offDto.team.ok && offDto.team.data.unassigned.name).toBe("Sin asignar");

    const seenOn: string[] = [];
    const onDto = await summaryReport("org_1", range, "MXN", {
      runReadOnly: run(seenOn),
      now: () => now,
      intakeEnabled: () => false,
      agendaEnabled: () => true,
    });
    expect(onDto.agendaEnabled).toBe(true);
    expect(seenOn).toContain(att);
    expect(onDto.bookings).toEqual({
      ok: true,
      data: { total: 5, scheduled: 1, realizada: 3, noShow: 1, rate: 0.75, cancelada: 0, pendingToMark: 0 },
    });
    expect(onDto.team.ok && onDto.team.data.totals.bookingsDone).toBe(0);
  });
});
