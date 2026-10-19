import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  SUMMARY_REPORT_SQL,
  shapeAttentionFigures,
  shapePending,
  shapeSummaryByAd,
  shapeSummaryByChannel,
  shapeSummaryByHour,
  summaryReport,
  type SummaryReportParams,
} from "@/server/reports/summary";
import { responseTimesSql } from "@/server/reports/agent";
import { parseReportRange } from "@/server/reports/range";
import type { ReportExec } from "@/server/reports/run";
import { ADS_REPORT_MAX_ROWS, SUMMARY_PENDING_MAX_ROWS } from "@/lib/reports";

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
    for (const [name, query] of all.filter(([n]) => n !== "salesByAdSql")) {
      expect(query.sql, name).toContain(`"c"."is_test" = false`);
    }
    expect(q("salesByAdSql").sql).toContain("lab.is_test = true");
    expect(q("salesByAdSql").sql).toContain("real_conv.is_test = false");
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

  it("por anuncio: primer anuncio del contacto y ventas por el primer anuncio del lead", () => {
    expect(q("personsByAdSql").sql).toContain("coalesce(fa.source_id, fa.attribution_id) as ad_key");
    expect(q("personsByAdSql").sql).toContain(
      `order by "ad_attribution"."contact_id", "ad_attribution"."created_at" asc, "ad_attribution"."id" asc`
    );
    const sales = q("salesByAdSql").sql;
    expect(sales).toContain("coalesce(closed.source_id, closed.attribution_id) as ad_key");
    expect(sales).toContain("closed.kind = 'won'");
    expect(sales).toContain("order by ev1.occurred_at desc, ev1.id desc");
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
    });
    const empty = shapeAttentionFigures([], [], []);
    expect(empty).toMatchObject({ persons: 0, answeredRate: null, attendedByAdvisorRate: null, handedOff: 0 });
  });

  it("021: tiempo hasta que atiende un asesor, null sin personas atendidas", () => {
    const f = shapeAttentionFigures([], [], [], [{ persons: "3", p50_s: "1020.5", p90_s: 3600 }]);
    expect(f.advisorFirstReply).toEqual({ persons: 3, p50Seconds: 1020.5, p90Seconds: 3600 });
    const none = shapeAttentionFigures([], [], [], [{ persons: 0, p50_s: null, p90_s: null }]);
    expect(none.advisorFirstReply).toEqual({ persons: 0, p50Seconds: null, p90Seconds: null });
  });

  it("por anuncio: une personas y ventas, sin anuncio aparte, monedas nunca sumadas", () => {
    const dto = shapeSummaryByAd(
      [
        { ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", persons: 3, new_persons: 2, inbound: 9, answered: 3, by_advisor: 1 },
        { ad_key: null, source_id: null, source_type: null, headline: null, persons: "5", new_persons: 0, inbound: 6, answered: 4, by_advisor: 0 },
        { ad_key: "at_x", source_id: null, source_type: "post", headline: null, persons: 1, new_persons: 1, inbound: 1, answered: 0, by_advisor: 0 },
      ],
      [
        { ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", currency: "MXN", has_amount: true, n: 1, cents: 50000 },
        { ad_key: "AD1", source_id: "AD1", source_type: "ad", headline: "Kit", currency: "USD", has_amount: true, n: 1, cents: 900 },
        // Venta de un anuncio sin personas en el rango: también sale.
        { ad_key: "AD9", source_id: "AD9", source_type: "ad", headline: null, currency: null, has_amount: false, n: 2, cents: 0 },
        { ad_key: null, source_id: null, source_type: null, headline: null, currency: null, has_amount: true, n: 1, cents: 1000 },
      ],
      "MXN"
    );
    expect(dto.total).toBe(3);
    expect(dto.rows.map((r) => r.key)).toEqual(["AD1", "at_x", "AD9"]);
    expect(dto.rows[0]).toMatchObject({ title: "Kit", persons: 3, newPersons: 2, inbound: 9, won: 2 });
    expect(dto.rows[0]!.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 50000,
      otherCurrencies: [{ currency: "USD", amountCents: 900, won: 1 }],
      wonWithoutAmount: 0,
    });
    expect(dto.rows[1]!.title).toBe("Publicación sin título");
    expect(dto.rows[2]).toMatchObject({ title: "Anuncio sin título", persons: 0, won: 2 });
    expect(dto.unidentified).toMatchObject({ persons: 5, inbound: 6, answered: 4, won: 1 });
    expect(dto.unidentified.wonAmount.amountCents).toBe(1000);
  });

  it("por anuncio: tope de filas, total completo", () => {
    const rows = Array.from({ length: ADS_REPORT_MAX_ROWS + 5 }, (_, i) => ({
      ad_key: `AD${i}`, source_id: `AD${i}`, persons: i + 1, new_persons: 0, inbound: 1, answered: 0, by_advisor: 0,
    }));
    const dto = shapeSummaryByAd(rows, [], "MXN");
    expect(dto.rows).toHaveLength(ADS_REPORT_MAX_ROWS);
    expect(dto.total).toBe(ADS_REPORT_MAX_ROWS + 5);
    expect(dto.rows[0]!.persons).toBe(ADS_REPORT_MAX_ROWS + 5);
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
    expect(dto.byAd.ok && dto.byAd.data).toMatchObject({ rows: [], total: 0 });
    expect(dto.byChannel.ok).toBe(true);
    expect(dto.pending.ok && dto.pending.data).toEqual({ total: 0, rows: [] });
    expect(dto.range.preset).toBe("today");
  });
});
