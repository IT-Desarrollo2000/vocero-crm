import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as agent from "@/server/reports/agent";
import {
  AGENT_REPORT_SQL,
  deliveryChannels,
  deliveryCutoff,
  pgTimestamp,
  type AgentReportParams,
} from "@/server/reports/agent";
import { CHANNEL_CAPABILITIES } from "@/server/channels/capabilities";

/**
 * 02 — Vigilancia del SQL del reporte del agente (M1–M8), sobre el SQL
 * RENDERIZADO. Si estás aquí porque se puso rojo: no relajes el test — una
 * métrica que cuenta el Laboratorio, o que depende del TimeZone de la sesión,
 * miente en silencio.
 */

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const norm = (s: string) => s.replace(/\s+/g, " ");

const P: AgentReportParams = {
  organizationId: "org_test",
  fromUtc: new Date("2026-10-01T06:00:00Z"),
  toUtc: new Date("2026-10-31T06:00:00Z"),
  tz: "America/Mexico_City",
  now: new Date("2026-10-20T12:00:00Z"),
};

const ALL = Object.entries(AGENT_REPORT_SQL).map(([name, build]) => ({
  name,
  q: render(build(P)),
}));
const byName = (name: keyof typeof AGENT_REPORT_SQL) => {
  const hit = ALL.find((x) => x.name === name);
  if (!hit) throw new Error(name);
  return { sql: norm(hit.q.sql), params: hit.q.params };
};

describe("guardián: todas las consultas", () => {
  it("la lista vigilada incluye cada builder `*Sql` exportado", () => {
    const exported = Object.keys(agent).filter((k) => /Sql$/.test(k));
    expect(exported.sort()).toEqual(Object.keys(AGENT_REPORT_SQL).sort());
    expect(ALL.length).toBeGreaterThanOrEqual(9);
  });

  it.each(ALL)("$name excluye el Laboratorio (join conversation + is_test = false)", ({ q }) => {
    expect(q.sql).toMatch(/join "conversation" "c" on "c"\."id" = /);
    expect(q.sql).toContain(`"c"."is_test" = false`);
  });

  it.each(ALL)("$name filtra por la organización (scoped) con parámetro", ({ q }) => {
    expect(q.sql).toMatch(/"(m|e)"\."organization_id" = \$\d+/);
    expect(q.params).toContain("org_test");
  });

  it.each(ALL)("$name: límites como texto ::timestamp, nunca now() ni Date", ({ q }) => {
    expect(q.sql).toMatch(/"created_at" >= \$\d+::timestamp/);
    expect(q.sql).toMatch(/"created_at" < \$\d+::timestamp/);
    expect(q.sql.toLowerCase()).not.toMatch(/\bnow\(\)|current_timestamp|current_date/);
    expect(q.params.some((v) => v instanceof Date)).toBe(false);
  });

  it("pgTimestamp: UTC sin zona", () => {
    expect(pgTimestamp(new Date("2026-10-01T06:00:00.123Z"))).toBe("2026-10-01 06:00:00.123");
  });
});

describe("M1 + M2 — reparto de atención", () => {
  const { sql, params } = byName("attentionSql");
  it("activas = con ≥ 1 entrante; IA/humano solo con salientes no fallidas", () => {
    expect(sql).toContain(`bool_or("m"."direction" = 'in') as has_in`);
    expect(sql).toContain(
      `"m"."origin" = 'ai' and "m"."status" <> 'failed') as has_ai`
    );
    expect(sql).toContain(
      `"m"."origin" in ('operator', 'manual', 'template') and "m"."status" <> 'failed') as has_human`
    );
    expect(sql).toContain("where act.has_in");
  });
  it("CTE esc: eventos opened del rango SIN manual_reply", () => {
    expect(sql).toContain(`"e"."kind" = 'opened'`);
    expect(sql).toContain(`"e"."reason" is distinct from 'manual_reply'`);
    expect(params).toContain("2026-10-01 06:00:00.000");
    expect(params).toContain("2026-10-31 06:00:00.000");
  });
});

describe("M3 — escalamientos (regla de manual_reply y approximate)", () => {
  it("conteos: todos los motivos (manual_reply se separa al dar forma) y aproximados contados", () => {
    const { sql } = byName("escalationCountsSql");
    expect(sql).toContain(`"e"."kind" = 'opened'`);
    expect(sql).toContain(`filter (where "e"."approximate")`);
    // approximate cuenta para totales: no se filtra fuera.
    expect(sql).not.toContain(`"e"."approximate" = false`);
    expect(sql).toContain(`group by "e"."reason"`);
  });
  it("muestras: sin manual_reply, solo con nota, 5 por motivo, con el contacto", () => {
    const { sql, params } = byName("escalationSamplesSql");
    expect(sql).toContain(`"e"."reason" is distinct from 'manual_reply'`);
    expect(sql).toContain(`"e"."note" is not null`);
    expect(sql).toContain(`partition by "e"."reason" order by "e"."created_at" desc`);
    expect(sql).toMatch(/join "contact" "ct" on "ct"\."id" = "c"\."contact_id"/);
    expect(params).toContain(5);
  });
  it("la hora del evento es created_at (no existe occurred_at en la tabla)", () => {
    for (const { q } of ALL) expect(q.sql).not.toContain(`"occurred_at"`);
  });
});

describe("M4 — tiempo a primera respuesta", () => {
  const { sql, params } = byName("responseTimesSql");
  it("lookback de 24 h calculado en Node", () => {
    expect(params).toContain("2026-09-30 06:00:00.000");
    expect(sql).toContain("created_at - prev_at >= interval '24 hours'");
  });
  it("respuesta = primer saliente no fallido posterior; IA vs humano", () => {
    expect(sql).toContain(`"r"."direction" = 'out' and "r"."status" <> 'failed'`);
    expect(sql).toContain(`order by "r"."created_at" limit 1`);
    expect(sql).toContain("when origin = 'ai' then 'ia' else 'humano'");
    expect(sql).toContain("percentile_cont(0.5)");
    expect(sql).toContain("percentile_cont(0.9)");
  });
});

describe("M5 — tiempo humano tras escalamiento", () => {
  const { sql } = byName("afterHandoffSql");
  it("solo eventos exactos y sin manual_reply", () => {
    expect(sql).toContain(`"e"."approximate" = false`);
    expect(sql).toContain(`"e"."reason" is distinct from 'manual_reply'`);
  });
  it("hasta el primer saliente HUMANO no fallido", () => {
    expect(sql).toContain(`"r"."origin" in ('operator', 'manual', 'template')`);
    expect(sql).toContain(`"r"."status" <> 'failed'`);
  });
});

describe("M6 — fallidas", () => {
  it("salientes por canal × origen", () => {
    const { sql } = byName("failuresSql");
    expect(sql).toContain(`"m"."direction" = 'out'`);
    expect(sql).toContain(`filter (where "m"."status" = 'failed')`);
    expect(sql).toContain("group by 1, 2");
    // Fallidas cuentan en TODOS los canales: sin filtro de canal.
    expect(sql).not.toContain(`"c"."channel" in`);
  });
  it("top 5 de errores", () => {
    const { sql, params } = byName("failureErrorsSql");
    expect(sql).toContain(`"m"."status" = 'failed'`);
    expect(params).toContain(5);
  });
});

describe("M7 — entrega y lectura", () => {
  const { sql, params } = byName("deliverySql");
  it("los canales salen de CHANNEL_CAPABILITIES.deliveryReceipts", () => {
    const expected = Object.entries(CHANNEL_CAPABILITIES)
      .filter(([, cap]) => cap.deliveryReceipts)
      .map(([ch]) => ch);
    expect(deliveryChannels()).toEqual(expected);
    expect(expected).toContain("whatsapp");
    for (const ch of expected) expect(params).toContain(ch);
    expect(params).not.toContain("instagram");
    expect(params).not.toContain("messenger");
    expect(sql).toMatch(/"c"\."channel" in \(\$\d+\)/);
  });
  it("excluye manual y los últimos 15 min (corte en Node)", () => {
    expect(sql).toContain(`"m"."origin" <> 'manual'`);
    expect(params).toContain("2026-10-20 11:45:00.000");
    expect(deliveryCutoff(P.toUtc, P.now).toISOString()).toBe("2026-10-20T11:45:00.000Z");
    // Rango ya cerrado: el corte es `to`.
    expect(deliveryCutoff(P.toUtc, new Date("2027-01-01T00:00:00Z"))).toEqual(P.toUtc);
  });
  it("entrega = (delivered + read) / (sent + delivered + read + failed); pending aparte", () => {
    expect(sql).toContain(`filter (where "m"."status" in ('delivered', 'read'))`);
    expect(sql).toContain(`filter (where "m"."status" in ('sent', 'delivered', 'read', 'failed'))`);
    expect(sql).toContain(`filter (where "m"."status" = 'pending')`);
  });
});

describe("M8 — volumen", () => {
  it("día local en la zona del negocio, sin depender del TimeZone de la sesión", () => {
    const { sql, params } = byName("volumeSql");
    expect(sql).toMatch(/\(\("m"\."created_at" at time zone 'UTC'\) at time zone \$\d+\)::date/);
    expect(params).toContain("America/Mexico_City");
    expect(sql).toContain("group by 1, 2, 3");
  });
});

describe("011 — la tarjeta de un lead externo no es un mensaje del cliente", () => {
  const NOT_INTAKE = `"m"."type" <> 'lead_intake'`;
  it("M1/M2: no activa la conversación (filtro dentro del CTE act)", () => {
    const { sql } = byName("attentionSql");
    const act = sql.slice(0, sql.indexOf("), esc as ("));
    expect(act).toContain(NOT_INTAKE);
  });
  it("M4: fuera del CTE msgs, así no abre sesión ni cuenta en el lag", () => {
    const { sql } = byName("responseTimesSql");
    const msgs = sql.slice(0, sql.indexOf("), ses as ("));
    expect(msgs).toContain("lag(");
    expect(msgs).toContain(NOT_INTAKE);
  });
  it("M8: no es volumen", () => {
    expect(byName("volumeSql").sql).toContain(NOT_INTAKE);
  });
  it("las métricas de salientes no lo necesitan (la tarjeta es entrante)", () => {
    for (const name of ["failuresSql", "deliverySql"] as const) {
      expect(byName(name).sql).toContain(`"m"."direction" = 'out'`);
    }
  });
});
