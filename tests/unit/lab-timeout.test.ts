import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Timeout del Laboratorio con cancelación cooperativa: al vencer, la corrida
 * queda `failed`, el agente (LLM) no recibe más turnos, y no hay escrituras
 * ni publicaciones SSE posteriores a `failRun`. En una corrida normal el timer
 * se limpia (no quedan timers pendientes).
 */

type Ev =
  | { kind: "insert"; table: string; values: unknown }
  | { kind: "update"; table: string; set: Record<string, unknown> }
  | { kind: "publish"; status: string }
  | { kind: "turn" }
  | { kind: "judge" };

const events: Ev[] = [];
const caseRows: unknown[] = [];

const runAgentTurn = vi.fn<(id: string) => Promise<void>>();
const judgeCase = vi.fn();

vi.mock("@/server/ai/pipeline", () => ({
  runAgentTurn: (id: string) => {
    events.push({ kind: "turn" });
    return runAgentTurn(id);
  },
}));

vi.mock("@/server/ai/prompts", () => ({ renderKb: () => "" }));

vi.mock("@/server/lab/judge", () => ({
  judgeCase: (input: unknown) => {
    events.push({ kind: "judge" });
    return judgeCase(input);
  },
  computeScore: () => 100,
}));

vi.mock("@/server/lab/personas", () => ({
  PERSONAS: [
    { key: "p1", label: "P1", description: "", phone: "5210000000001", contactName: "[Prueba] 1", script: ["hola", "precio?"] },
    { key: "p2", label: "P2", description: "", phone: "5210000000002", contactName: "[Prueba] 2", script: ["hola"] },
  ],
}));

vi.mock("@/server/events/bus", () => ({
  publish: (_org: string, event: { data: { status: string } }) => {
    events.push({ kind: "publish", status: event.data.status });
  },
}));

function thenable(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: (table: { __name: string }) =>
        thenable(
          table.__name === "agentTestCase"
            ? caseRows
            : table.__name === "conversation"
              ? [{ handoffAt: null }]
              : []
        ),
    }),
    insert: (table: { __name: string }) => ({
      values: (values: unknown) => {
        events.push({ kind: "insert", table: table.__name, values });
        if (table.__name === "agentTestCase") caseRows.push(...(values as unknown[]));
        const chain = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    update: (table: { __name: string }) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          events.push({ kind: "update", table: table.__name, set });
          return {
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve([]).then(resolve),
          };
        },
      }),
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__name" ? String(tableName) : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

const isRunFailed = (e: Ev) =>
  e.kind === "update" && e.table === "agentTestRun" && e.set.status === "failed";

describe("timeout del Laboratorio", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    caseRows.length = 0;
    runAgentTurn.mockReset();
    judgeCase.mockReset();
    judgeCase.mockResolvedValue({
      status: "done",
      verdict: { veredicto: "verde", hallazgos: [] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("corrida que excede el timeout → failed, sin más turnos ni escrituras tras failRun", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    // El turno tarda 5 s: vence el timeout en pleno turno, y el turno termina
    // dentro de la gracia.
    runAgentTurn.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000))
    );

    const { startRun } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(1000);

    // Abortado pero aún en gracia: el run sigue `running` (candado tomado).
    expect(events.some(isRunFailed)).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    const failIdx = events.findIndex(isRunFailed);
    expect(failIdx).toBeGreaterThan(-1);
    const failed = events[failIdx];
    expect(failed?.kind === "update" && failed.set.error).toContain(
      "timeout de 1000 ms"
    );

    // Un solo turno, sin juez: el segundo turno y la segunda persona nunca
    // llegaron al LLM.
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(judgeCase).not.toHaveBeenCalled();

    // El caso en curso quedó en estado terminal ANTES de failRun.
    const closeIdx = events.findIndex(
      (e) =>
        e.kind === "update" &&
        e.table === "agentTestCase" &&
        e.set.status === "judge_failed"
    );
    expect(closeIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeLessThan(failIdx);

    // La conversación quedó ligada al caso (borrarla no deja huérfanas).
    expect(
      events.some(
        (e) =>
          e.kind === "update" &&
          e.table === "agentTestCase" &&
          typeof e.set.conversationId === "string"
      )
    ).toBe(true);

    // Lo único tras failRun es su propia publicación `failed`.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(events.slice(failIdx + 1)).toEqual([
      { kind: "publish", status: "failed" },
    ]);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turno colgado más allá de la gracia → failRun igual, y la zombi no escribe al volver", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    let releaseTurn: () => void = () => {};
    runAgentTurn.mockImplementation(
      () => new Promise<void>((resolve) => (releaseTurn = resolve))
    );

    const { startRun, ABORT_GRACE_MS } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(1000 + ABORT_GRACE_MS);

    const failIdx = events.findIndex(isRunFailed);
    expect(failIdx).toBeGreaterThan(-1);
    expect(vi.getTimerCount()).toBe(0);

    // El turno del LLM por fin regresa: la corrida zombi debe salir sin más.
    releaseTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(events.slice(failIdx + 1)).toEqual([
      { kind: "publish", status: "failed" },
    ]);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(judgeCase).not.toHaveBeenCalled();
  });

  it("corrida normal → done y sin timers pendientes", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    runAgentTurn.mockResolvedValue(undefined);

    const { startRun } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual({ kind: "publish", status: "done" });
    expect(events.some(isRunFailed)).toBe(false);
    expect(runAgentTurn).toHaveBeenCalledTimes(3); // 2 líneas + 1 línea
    expect(judgeCase).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    // Ni pasado el timeout aparece un `failed` tardío.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.some(isRunFailed)).toBe(false);
  });
});

describe("fallo propio de la corrida", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    caseRows.length = 0;
    runAgentTurn.mockReset();
    judgeCase.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("error del juez → failed una sola vez y el timer se limpia", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    runAgentTurn.mockResolvedValue(undefined);
    judgeCase.mockRejectedValue(new Error("juez caído"));

    const { startRun } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(0);

    const fails = events.filter(isRunFailed);
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind === "update" && fails[0].set.error).toContain(
      "juez caído"
    );
    expect(vi.getTimerCount()).toBe(0);

    // Pasado el timeout no aparece un segundo `failed`.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.filter(isRunFailed)).toHaveLength(1);
  });
});

describe("LAB_RUN_TIMEOUT_MS", () => {
  it("entero positivo → se usa; inválido → 10 minutos", async () => {
    const { parseRunTimeoutMs } = await import("@/server/lab/runner");
    expect(parseRunTimeoutMs("1500")).toBe(1500);
    expect(parseRunTimeoutMs(" 2000 ")).toBe(2000);
    for (const bad of [undefined, "", "0", "-5", "1.5", "abc", "1e3", "99999999999"]) {
      expect(parseRunTimeoutMs(bad)).toBe(600_000);
    }
  });
});
