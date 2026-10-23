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
  | { kind: "judge" }
  | { kind: "seed" };

const events: Ev[] = [];
const caseRows: unknown[] = [];
/** 030 — Estado de la conversación tras cada turno (por defecto, sin pase). */
const NO_HANDOFF = [{ handoffAt: null, handoffReason: null, handoffNote: null }];
let convRows: unknown[] = NO_HANDOFF;

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

// 08 — Las personas salen de la BD (`persona-store`); aquí, dos de prueba.
// `personas.ts` corre REAL (snapshot y hash).
const labPersona = (key: string, phone: string, guion: string[]) => ({
  id: `lpe_${key}`,
  key,
  name: key.toUpperCase(),
  objetivo: "",
  rasgos: null,
  guion,
  criteriosExito: null,
  contactName: `[Prueba] ${key}`,
  phone,
  active: true,
  position: 0,
});
const ensureSeedPersonas = vi.fn();
vi.mock("@/server/lab/persona-store", () => ({
  ensureSeedPersonas: (org: string) => ensureSeedPersonas(org),
  loadRunPersonas: async () => [
    labPersona("p1", "5210000000001", ["hola", "precio?"]),
    labPersona("p2", "5210000000002", ["hola"]),
  ],
}));

const totals: { status: string; total: number }[] = [];
vi.mock("@/server/events/bus", () => ({
  publish: (
    _org: string,
    event: { data: { status: string; progress: { total: number } } }
  ) => {
    events.push({ kind: "publish", status: event.data.status });
    totals.push({ status: event.data.status, total: event.data.progress.total });
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
              ? convRows
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
    totals.length = 0;
    convRows = NO_HANDOFF;
    ensureSeedPersonas.mockReset();
    ensureSeedPersonas.mockImplementation(async () => {
      events.push({ kind: "seed" });
      return null;
    });
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
    // 08 — `failRun` publica el total = nº de casos de la corrida (2).
    expect(totals.find((t) => t.status === "failed")?.total).toBe(2);
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

  it("030 — pase a asesor: corta el guion y el juez recibe motivo y nota", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    runAgentTurn.mockResolvedValue(undefined);
    convRows = [
      { handoffAt: new Date(), handoffReason: "cliente", handoffNote: "pidió humano" },
    ];

    const { startRun } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(0);

    expect(runAgentTurn).toHaveBeenCalledTimes(2); // 1 por persona: corta al pase
    expect(judgeCase.mock.calls[0]![0]).toMatchObject({
      personaKey: "p1",
      handoff: { reason: "cliente", note: "pidió humano" },
    });
  });

  it("08 — siembra antes del run; snapshot y claves en el INSERT; un caso por persona con su snapshot", async () => {
    vi.stubEnv("LAB_RUN_TIMEOUT_MS", "1000");
    vi.stubEnv("OPENROUTER_MODEL", "modelo/agente");
    runAgentTurn.mockResolvedValue(undefined);

    const { startRun } = await import("@/server/lab/runner");
    await startRun("org_1");
    await vi.advanceTimersByTimeAsync(0);

    const seedIdx = events.findIndex((e) => e.kind === "seed");
    const runIdx = events.findIndex((e) => e.kind === "insert" && e.table === "agentTestRun");
    expect(seedIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeLessThan(runIdx);

    const runInsert = events[runIdx] as Extract<Ev, { kind: "insert" }>;
    const values = runInsert.values as {
      personaKeys: string[];
      configSnapshot: { version: number; kb: { mode: string }; personas: { key: string; hash: string }[]; models: { agent: string | null } };
    };
    expect(values.personaKeys).toEqual(["p1", "p2"]);
    expect(values.configSnapshot.version).toBe(1);
    expect(values.configSnapshot.kb.mode).toBe("full");
    expect(values.configSnapshot.personas.map((p) => p.key)).toEqual(["p1", "p2"]);
    expect(values.configSnapshot.personas[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(values.configSnapshot.models.agent).toBe("modelo/agente");

    const cases = caseRows as { persona: string; personaSnapshot: { key: string; name: string; guion: string[] } }[];
    expect(cases.map((c) => c.persona)).toEqual(["p1", "p2"]);
    expect(cases[0]!.personaSnapshot).toMatchObject({ key: "p1", name: "P1", guion: ["hola", "precio?"] });

    // El juez recibió la persona del snapshot.
    expect(judgeCase.mock.calls[0]![0]).toMatchObject({
      personaKey: "p1",
      persona: { name: "P1", objetivo: "" },
      // 030 — Sin pase a asesor en la conversación → el juez recibe null.
      handoff: null,
    });
    expect(totals.at(-1)).toEqual({ status: "done", total: 2 });

    // Sandbox (RF-08-09): personas de BD (personalizadas) → conversación
    // is_test y contacto sintético archivado con el teléfono del snapshot.
    const convs = events.filter(
      (e): e is Extract<Ev, { kind: "insert" }> => e.kind === "insert" && e.table === "conversation"
    );
    expect(convs).toHaveLength(2);
    expect(convs.every((c) => (c.values as { isTest: boolean }).isTest === true)).toBe(true);
    const contacts = events.filter(
      (e): e is Extract<Ev, { kind: "insert" }> => e.kind === "insert" && e.table === "contact"
    );
    expect(contacts.map((c) => (c.values as { phone: string }).phone)).toEqual([
      "5210000000001",
      "5210000000002",
    ]);
    expect(contacts.every((c) => (c.values as { archivedAt: unknown }).archivedAt instanceof Date)).toBe(true);
  });
});

describe("fallo propio de la corrida", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    caseRows.length = 0;
    totals.length = 0;
    ensureSeedPersonas.mockReset();
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
