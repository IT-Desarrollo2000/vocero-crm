import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  REPORT_CONCURRENCY,
  ReportTimeoutError,
  isStatementTimeout,
  runBlocks,
  type ReportExec,
} from "@/server/reports/run";
import { agentReport } from "@/server/reports/agent";
import { parseReportRange } from "@/server/reports/range";

/**
 * 02 — Ejecución del reporte: concurrencia LIMITADA (el pool es `max: 10` y
 * compite con el webhook), degradación por bloque y 503 solo si todo vence.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeoutErr = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
const silent = { onError: () => {} };

describe("runBlocks", () => {
  it("nunca corre más de 2 bloques a la vez (default)", async () => {
    expect(REPORT_CONCURRENCY).toBe(2);
    let inFlight = 0;
    let max = 0;
    const task = (v: number) => async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(15);
      inFlight--;
      return v;
    };
    const res = await runBlocks({ a: task(1), b: task(2), c: task(3), d: task(4), e: task(5), f: task(6), g: task(7) });
    expect(max).toBe(2);
    expect(res.g).toEqual({ ok: true, data: 7 });
  });

  it("cada bloque degrada por separado: timeout vs unavailable", async () => {
    const res = await runBlocks(
      {
        ok: async () => 1,
        lento: async () => {
          throw timeoutErr();
        },
        roto: async () => {
          throw new Error("relation does not exist");
        },
      },
      silent
    );
    expect(res.ok).toEqual({ ok: true, data: 1 });
    expect(res.lento).toEqual({ ok: false, error: "timeout" });
    expect(res.roto).toEqual({ ok: false, error: "unavailable" });
  });

  it("todos fallan y alguno por tiempo → ReportTimeoutError (503)", async () => {
    await expect(
      runBlocks(
        {
          a: async () => {
            throw timeoutErr();
          },
          b: async () => {
            throw new Error("x");
          },
        },
        silent
      )
    ).rejects.toBeInstanceOf(ReportTimeoutError);
  });

  it("todos fallan sin timeout → no es 503 (bloques no disponibles)", async () => {
    const res = await runBlocks(
      {
        a: async () => {
          throw new Error("x");
        },
      },
      silent
    );
    expect(res.a).toEqual({ ok: false, error: "unavailable" });
  });

  it("vencido el presupuesto total, lo que no arrancó se marca timeout sin correr", async () => {
    let t = 0;
    let ran = 0;
    const res = await runBlocks(
      {
        a: async () => {
          ran++;
          t = 100; // el reloj salta tras el primer bloque
          return 1;
        },
        b: async () => {
          ran++;
          return 2;
        },
      },
      { concurrency: 1, deadlineMs: 50, now: () => t }
    );
    expect(ran).toBe(1);
    expect(res.a).toEqual({ ok: true, data: 1 });
    expect(res.b).toEqual({ ok: false, error: "timeout" });
  });

  it("isStatementTimeout sigue la causa de un error envuelto", () => {
    expect(isStatementTimeout(timeoutErr())).toBe(true);
    expect(isStatementTimeout(new Error("wrap", { cause: timeoutErr() }))).toBe(true);
    expect(isStatementTimeout(new Error("otro"))).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
  });
});

describe("agentReport con BD falsa", () => {
  const range = (() => {
    const r = parseReportRange({ range: "7d" }, "America/Mexico_City", new Date("2026-10-12T18:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    return r.range;
  })();
  const dialect = new PgDialect();

  function fakeRun(failWhen: (sql: string) => Error | null) {
    let inFlight = 0;
    const state = { max: 0, queries: [] as string[] };
    const runReadOnly = async <T,>(fn: (exec: ReportExec) => Promise<T>): Promise<T> => {
      inFlight++;
      state.max = Math.max(state.max, inFlight);
      try {
        const exec = (async (q: SQL) => {
          const text = dialect.sqlToQuery(q).sql;
          state.queries.push(text);
          await sleep(5);
          const err = failWhen(text);
          if (err) throw err;
          return [];
        }) as ReportExec;
        return await fn(exec);
      } finally {
        inFlight--;
      }
    };
    return { runReadOnly, state };
  }

  it("un bloque caído no tumba los demás; rango con días y zona", async () => {
    const { runReadOnly, state } = fakeRun((s) => (s.includes("percentile_cont") && s.includes("ses as") ? new Error("boom") : null));
    const dto = await agentReport("org_x", range, {
      runReadOnly,
      now: () => new Date("2026-10-12T18:00:00Z"),
      blocks: { onError: () => {} },
    });
    expect(state.max).toBeLessThanOrEqual(2);
    expect(dto.responseTimes).toEqual({ ok: false, error: "unavailable" });
    expect(dto.attention).toEqual({
      ok: true,
      data: { active: 0, aiOnly: 0, aiAndHuman: 0, humanOnly: 0, noReply: 0, aiOnlyRate: null },
    });
    expect(dto.afterHandoff?.ok).toBe(true);
    expect(dto.range.days).toHaveLength(7);
    expect(dto.range.tz).toBe("America/Mexico_City");
    expect(dto.range.preset).toBe("7d");
    if (dto.volume.ok) expect(dto.volume.data.rows).toHaveLength(7);
    else throw new Error("volume debía estar ok");
    // Toda consulta que se ejecutó excluye el Laboratorio.
    expect(state.queries.length).toBeGreaterThanOrEqual(9);
    for (const q of state.queries) expect(q).toContain(`"c"."is_test" = false`);
  });

  it("todas las consultas vencen → ReportTimeoutError", async () => {
    const { runReadOnly } = fakeRun(() => timeoutErr());
    await expect(
      agentReport("org_x", range, {
        runReadOnly,
        now: () => new Date("2026-10-12T18:00:00Z"),
        blocks: { onError: () => {} },
      })
    ).rejects.toBeInstanceOf(ReportTimeoutError);
  });
});
