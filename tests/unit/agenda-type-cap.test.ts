import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 023 — Tope a la pregunta del tipo de cita. Si el agente ya preguntó "¿Qué
 * tipo de cita te interesa?" en su último mensaje y el tipo sigue sin
 * resolverse, preguntar otra vez sería un bucle: el turno pasa a un humano.
 */

vi.mock("@/lib/ai", () => ({ chatJson: vi.fn() }));

const loadHistoryRows = vi.fn();
vi.mock("@/server/ai/history", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/ai/history")>();
  return { ...original, loadHistoryRows };
});
vi.mock("@/server/ai/contact-context", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/ai/contact-context")>();
  return {
    ...original,
    loadContactContext: vi.fn().mockResolvedValue({
      now: new Date(),
      timezone: "America/Mexico_City",
      contact: null,
      lead: null,
      recurrent: null,
    }),
  };
});

const markHandoff = vi.fn(async (_input: Record<string, unknown>) => {});
vi.mock("@/server/inbox/handoff", () => ({ markHandoff }));

const QUESTION =
  "¿Qué tipo de cita te interesa? Tengo: Prueba de manejo, Servicio, Garantía u Otro.";
const offerSlots = vi.fn(async () => ({ ok: false, text: QUESTION }));
vi.mock("@/server/agenda/agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/agent")>();
  return { ...original, offerSlots, bookSlot: vi.fn() };
});
vi.mock("@/server/agenda/types-store", () => ({
  listTypes: async () => [{ name: "Prueba de manejo" }, { name: "Servicio" }],
}));

const outbound: string[] = [];
const selectQueue: unknown[][] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => {
  const fakeDb = {
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if (values.direction === "out") outbound.push(String(values.text));
        return Promise.resolve([values]);
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{}]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([{}]).then(resolve),
        }),
      }),
    }),
  };
  return {
    getDb: () => fakeDb,
    schema: new Proxy(
      {},
      {
        get: (_t, tableName) =>
          new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
      }
    ),
  };
});

const conversation = {
  id: "cv_lab",
  organizationId: "org_1",
  contactId: "ct_lab",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  handoffNote: null,
  lastInboundAt: new Date(),
};
const profile = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

async function turn(history: unknown[]) {
  const { chatJson } = await import("@/lib/ai");
  vi.mocked(chatJson).mockResolvedValueOnce({
    ok: true,
    data: { action: "offer_slots", type: "lavado" },
    raw: "{}",
  });
  selectQueue.push([conversation], [profile], [], []);
  loadHistoryRows.mockResolvedValueOnce(history);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_lab");
}

describe("tope a la pregunta del tipo de cita", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    outbound.length = 0;
    markHandoff.mockClear();
    offerSlots.mockClear();
    vi.stubEnv("AGENDA", "on");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });

  it("la primera vez pregunta el tipo", async () => {
    await turn([{ direction: "in", text: "quiero una cita" }]);
    expect(offerSlots).toHaveBeenCalledOnce();
    expect(outbound).toEqual([QUESTION]);
    expect(markHandoff).not.toHaveBeenCalled();
  });

  it("si su último mensaje ya fue la pregunta y sigue sin resolverse, escala sin repetirla", async () => {
    await turn([
      { direction: "in", text: "quiero una cita" },
      { direction: "out", text: QUESTION, aiGenerated: true },
      { direction: "in", text: "la de lavar el coche" },
    ]);
    expect(outbound).toEqual([]);
    expect(markHandoff).toHaveBeenCalledOnce();
    expect(markHandoff.mock.calls[0]![0]).toMatchObject({
      conversationId: "cv_lab",
      reason: "modelo",
      source: "agente",
    });
  });

  it("una pregunta escrita por un ASESOR no cuenta: el agente sí pregunta", async () => {
    await turn([
      { direction: "in", text: "quiero una cita" },
      { direction: "out", text: QUESTION, aiGenerated: false },
      { direction: "in", text: "mmm" },
    ]);
    expect(outbound).toEqual([QUESTION]);
    expect(markHandoff).not.toHaveBeenCalled();
  });
});
