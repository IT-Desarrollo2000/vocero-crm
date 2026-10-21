import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 025 — El turno del agente con agenda (pipeline):
 *  - barrera (A4): un `reply` con horarios escritos por el modelo NO se envía;
 *    sale la oferta del MOTOR (intro del motor, día deducido);
 *  - las ofertas y el trato se cargan una vez y viajan al motor (A2);
 *  - el saliente del motor guarda `agent_action` también en el Laboratorio (A5).
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

const MOTOR_ACTION = {
  action: "offer_slots" as const,
  type: "Prueba de manejo",
  date: "2026-10-23",
  part: null,
  shown: ["vie 23 oct 10:00", "vie 23 oct 12:00"],
};
const MOTOR_TEXT =
  "Para el viernes 23 de octubre tengo estos horarios para su prueba de manejo:\n• 10:00\n• 12:00";
const offerSlots = vi.fn(async (_input: Record<string, unknown>) => ({
  ok: true,
  text: MOTOR_TEXT,
  agentAction: MOTOR_ACTION,
}));
const bookSlot = vi.fn(async (_input: Record<string, unknown>) => ({
  ok: true,
  text: "¡Listo! Le agendé su prueba de manejo para vie 23 oct, 11:00.",
  agentAction: { action: "book_slot" as const, booked: "vie 23 oct 11:00" },
}));
vi.mock("@/server/agenda/agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/agent")>();
  return { ...original, offerSlots, bookSlot };
});
vi.mock("@/server/agenda/types-store", () => ({
  listTypes: async () => [
    { id: "apt_p", name: "Prueba de manejo" },
    { id: "apt_s", name: "Servicio" },
  ],
}));
vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({ timezone: "America/Mexico_City" }),
  DEFAULT_TIMEZONE: "America/Mexico_City",
}));
const OFFERS = [
  { startUtc: "2026-10-23T16:00:00.000Z", label: "vie 23 oct, 10:00", typeId: "apt_p" },
  { startUtc: "2026-10-23T17:00:00.000Z", label: "vie 23 oct, 11:00", typeId: "apt_p" },
];
let offers: typeof OFFERS = [];
vi.mock("@/server/agenda/offers", () => ({ getOffers: async () => offers }));

const inserted: Record<string, unknown>[] = [];
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
        if (values.direction === "out") inserted.push(values);
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
  formality: "usted",
};

const INVENTED =
  "Tengo estos horarios disponibles para el viernes, 24 de octubre a las 10:00 • viernes, 24 de octubre a las 10:30 • viernes, 24 de octubre a las 11:00";

async function turn(data: unknown, history: unknown[] = [{ direction: "in", text: "¿y el viernes?" }]) {
  const { chatJson } = await import("@/lib/ai");
  vi.mocked(chatJson).mockResolvedValueOnce({ ok: true, data, raw: "{}" } as never);
  selectQueue.push([conversation], [profile], [], []);
  loadHistoryRows.mockResolvedValueOnce(history);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_lab");
  return vi.mocked(chatJson).mock.calls.at(-1)![1] as { role: string; content: string }[];
}

describe("pipeline con agenda — barrera, ofertas y agent_action", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Miércoles 21 de octubre de 2026, 12:24 en CDMX.
    vi.setSystemTime(new Date("2026-10-21T18:24:00.000Z"));
    selectQueue.length = 0;
    inserted.length = 0;
    offers = [];
    markHandoff.mockClear();
    offerSlots.mockClear();
    bookSlot.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AGENDA", "on");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("un reply con horas inventadas NO se envía: sale la oferta del motor del viernes REAL", async () => {
    offers = OFFERS;
    await turn({ action: "reply", text: INVENTED });
    expect(inserted.map((m) => m.text)).toEqual([MOTOR_TEXT]);
    expect(offerSlots).toHaveBeenCalledOnce();
    const input = offerSlots.mock.calls[0]![0];
    expect(input).toMatchObject({
      date: "2026-10-23",
      typeName: "Prueba de manejo",
      formality: "usted",
    });
    // La intro es la del motor, nunca el texto del modelo.
    expect(input.intro).toBeUndefined();
    // Laboratorio (A5): el saliente del motor guarda su acción.
    expect(inserted[0]!.agentAction).toEqual(MOTOR_ACTION);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[agente] barrera de horarios"));
  });

  it("sin oferta vigente el tipo queda al motor (que resuelve o pregunta)", async () => {
    await turn({ action: "reply", text: INVENTED });
    expect(offerSlots.mock.calls[0]![0].typeName).toBeUndefined();
  });

  it("la intro de offer_slots con horarios se descarta; un reply normal pasa tal cual", async () => {
    await turn({ action: "offer_slots", type: "Prueba", reply: INVENTED, date: "2026-10-23" });
    expect(offerSlots.mock.calls[0]![0]).toMatchObject({ date: "2026-10-23", intro: undefined });

    inserted.length = 0;
    await turn({ action: "reply", text: "El precio de contado es de $285,990." });
    expect(inserted.map((m) => m.text)).toEqual(["El precio de contado es de $285,990."]);
    expect(inserted[0]!.agentAction).toBeNull();
  });

  it("el prompt trae HORARIOS OFRECIDOS con * y book_slot reserva contra ESE array", async () => {
    offers = OFFERS;
    const history = [
      { direction: "in", text: "quiero una prueba el viernes" },
      {
        direction: "out",
        aiGenerated: true,
        text: "Para el viernes… • 10:00",
        agentAction: { action: "offer_slots", date: "2026-10-23", shown: ["vie 23 oct 10:00"] },
      },
      { direction: "in", text: "11" },
    ];
    const messages = await turn({ action: "book_slot", slot: "2026-10-23 11:00" }, history);
    const system = messages[0]!.content;
    expect(system).toContain("* 2026-10-23 10:00 (vie) — Prueba de manejo");
    expect(system).toContain("- 2026-10-23 11:00 (vie) — Prueba de manejo");
    expect(system).toContain("Hoy: miércoles 21 oct 2026 12:24");
    // El historial ve la ACCIÓN, no el texto con horas (A6).
    expect(messages[2]!.content).toBe(
      JSON.stringify({ action: "offer_slots", date: "2026-10-23", shown: ["vie 23 oct 10:00"] })
    );
    expect(bookSlot.mock.calls[0]![0]).toMatchObject({
      slot: "2026-10-23 11:00",
      offers: OFFERS,
      shown: ["vie 23 oct 10:00"],
      formality: "usted",
    });
    expect(inserted[0]!.agentAction).toEqual({ action: "book_slot", booked: "vie 23 oct 11:00" });
  });

  it("B1: el reply de book_slot viaja al motor como intro (el precio no se pierde)", async () => {
    offers = OFFERS;
    await turn({
      action: "book_slot",
      slot: "2026-10-23 11:00",
      reply: "El Macaron 2P cuesta $285,990.",
    });
    expect(bookSlot.mock.calls[0]![0]).toMatchObject({
      slot: "2026-10-23 11:00",
      intro: "El Macaron 2P cuesta $285,990.",
    });
  });

  it("B1: el reply de book_slot con horarios inventados se descarta (y la reserva sigue)", async () => {
    offers = OFFERS;
    await turn({ action: "book_slot", slot: "2026-10-23 11:00", reply: INVENTED });
    expect(bookSlot).toHaveBeenCalledOnce();
    expect(bookSlot.mock.calls[0]![0].intro).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[agente] barrera de horarios"));
  });

  it("R1: si la barrera convirtió el reply y el motor falla, sale checkLater (usted), no silencio", async () => {
    offers = OFFERS;
    vi.spyOn(console, "error").mockImplementation(() => {});
    offerSlots.mockRejectedValueOnce(new Error("motor caído"));
    await turn({ action: "reply", text: INVENTED });
    expect(inserted.map((m) => m.text)).toEqual([
      "Permítame revisar los horarios disponibles con el equipo y le confirmo.",
    ]);
  });

  it("R1: lo mismo si la barrera descartó la intro de offer_slots", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    offerSlots.mockRejectedValueOnce(new Error("motor caído"));
    await turn({ action: "offer_slots", type: "Prueba", reply: INVENTED });
    expect(inserted.map((m) => m.text)).toEqual([
      "Permítame revisar los horarios disponibles con el equipo y le confirmo.",
    ]);
  });

  it("R3: el historial muestra el reply del modelo DENTRO de la acción", async () => {
    offers = OFFERS;
    const history = [
      { direction: "in", text: "11, ¿y cuánto cuesta?" },
      {
        direction: "out",
        aiGenerated: true,
        text: "El Macaron 2P cuesta $285,990.\n¡Listo! Le agendé…",
        agentAction: {
          action: "book_slot",
          booked: "vie 23 oct 11:00",
          reply: "El Macaron 2P cuesta $285,990.",
        },
      },
      { direction: "in", text: "gracias" },
    ];
    const messages = await turn({ action: "reply", text: "A usted." }, history);
    expect(messages[2]!.content).toBe(
      JSON.stringify({
        action: "book_slot",
        booked: "vie 23 oct 11:00",
        reply: "El Macaron 2P cuesta $285,990.",
      })
    );
  });

  it("un handoff con despedida inventada escala sin mandar las horas", async () => {
    await turn({ action: "handoff", reason: "x", farewell: INVENTED });
    expect(inserted).toEqual([]);
    expect(markHandoff).toHaveBeenCalledOnce();
  });

  it("con AGENDA apagada no hay barrera ni agenda en el prompt", async () => {
    vi.stubEnv("AGENDA", "off");
    const messages = await turn({ action: "reply", text: INVENTED });
    expect(offerSlots).not.toHaveBeenCalled();
    expect(inserted.map((m) => m.text)).toEqual([INVENTED]);
    expect(messages[0]!.content).not.toContain("HORARIOS OFRECIDOS");
  });
});
