import { beforeEach, describe, expect, it, vi } from "vitest";
import { FICHA_TEMPLATE_AUTOS_ELECTRICOS } from "@/lib/ficha-fields";

/**
 * 04 — El turno del agente escribe la ficha DESPUÉS de entregar la respuesta
 * y nunca escala por ella (RF-04-10). La puerta (`@/server/bot/ficha`) va
 * mockeada: su transacción no entra a la cola de selects del turno.
 */

vi.mock("@/lib/ai", () => ({ chatJson: vi.fn() }));

const upsertFicha = vi.fn();
vi.mock("@/server/bot/ficha", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/bot/ficha")>();
  return { ...original, upsertFicha };
});

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

// Orden observable: cada inserción de mensaje y cada escritura de ficha.
const timeline: string[] = [];
const selectQueue: unknown[][] = [];
const updates: Record<string, unknown>[] = [];
// 030 — Si es true, la próxima inserción de saliente truena (envío fallido).
let failNextOutbound = false;

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
        if (values.direction === "out" && failNextOutbound) {
          failNextOutbound = false;
          return Promise.reject(new Error("BD caída al enviar"));
        }
        if (values.direction === "out") timeline.push(`out:${String(values.text)}`);
        return Promise.resolve([values]);
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        // 030 — El handoff también entra a la línea de tiempo (orden aviso → escalado).
        if (values.handoffAt instanceof Date) {
          timeline.push(`handoff:${String(values.handoffReason)}`);
        }
        return {
          where: () => ({
            // La conversación del turno es del Laboratorio (isTest): markHandoff
            // lee `isTest` del RETURNING para no registrar ni publicar.
            returning: () =>
              Promise.resolve([{ id: "cv_x", isTest: true, ...values }]),
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve([{}]).then(resolve),
          }),
        };
      },
    }),
    // markHandoff (05/02-0) escribe dentro de una transacción.
    transaction: <T,>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
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
const baseProfile = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};
const withFields = { ...baseProfile, fichaFields: [...FICHA_TEMPLATE_AUTOS_ELECTRICOS] };

async function turn(
  profile: object,
  data: unknown,
  // 030 — Historial a simular (por defecto, un entrante).
  rows: unknown[] = [
    { direction: "in", text: "me interesa el T03, soy de Villahermosa" },
  ]
) {
  const { chatJson } = await import("@/lib/ai");
  vi.mocked(chatJson).mockResolvedValueOnce({ ok: true, data, raw: "{}" });
  selectQueue.push([conversation], [profile], [], []);
  loadHistoryRows.mockResolvedValueOnce(rows);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_lab");
  return vi.mocked(chatJson).mock.calls.at(-1)?.[1] ?? [];
}

const FICHA = { modelo_interes: "T03", ciudad: "Villahermosa" };

describe("turno del agente con ficha", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updates.length = 0;
    timeline.length = 0;
    upsertFicha.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });

  it("escribe la ficha DESPUÉS de entregar la respuesta, como `ia` y con la definición", async () => {
    upsertFicha.mockImplementation(async () => {
      timeline.push("ficha");
      return { ficha: FICHA, meta: {}, ignored: [], changed: true };
    });
    await turn(withFields, { action: "reply", text: "¡Claro!", ficha: FICHA });

    expect(timeline).toEqual(["out:¡Claro!", "ficha"]);
    expect(upsertFicha).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        contactId: "ct_lab",
        ficha: FICHA,
        source: "ia",
        conversationId: "cv_lab",
        fields: withFields.fichaFields,
      })
    );
  });

  it("si la escritura truena, el cliente ya tiene su respuesta y NO hay handoff", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    upsertFicha.mockRejectedValueOnce(new Error("BD caída a mitad"));
    await turn(withFields, { action: "reply", text: "¡Claro!", ficha: FICHA });

    expect(timeline).toEqual(["out:¡Claro!"]);
    expect(updates.some((u) => u.handoffAt instanceof Date)).toBe(false);
    // El log lleva claves, nunca valores.
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("modelo_interes");
    expect(logged).not.toContain("Villahermosa");
    err.mockRestore();
  });

  it("handoff con ficha: se escala Y se guarda la ficha (le sirve a quien hereda)", async () => {
    upsertFicha.mockResolvedValueOnce({ ficha: FICHA, meta: {}, ignored: [], changed: true });
    await turn(withFields, { action: "handoff", reason: "pide humano", ficha: FICHA });
    expect(updates.some((u) => u.handoffReason === "modelo")).toBe(true);
    expect(upsertFicha).toHaveBeenCalledTimes(1);
  });

  it("sin definición de campos: no escribe la ficha y el prompt no la menciona", async () => {
    const messages = await turn(baseProfile, { action: "reply", text: "ok", ficha: FICHA });
    expect(upsertFicha).not.toHaveBeenCalled();
    const system = String(messages[0]?.content ?? "");
    expect(system).not.toContain('"ficha"');
    expect(system).not.toContain("CAMPOS DE LA FICHA");
  });

  it("con definición, el prompt lista los campos que llena el agente y sus reglas", async () => {
    upsertFicha.mockResolvedValue({ ficha: {}, meta: {}, ignored: [], changed: false });
    const fields = [
      ...FICHA_TEMPLATE_AUTOS_ELECTRICOS,
      { key: "interno", label: "Dato interno", type: "texto" as const, agentFills: false },
    ];
    const messages = await turn({ ...baseProfile, fichaFields: fields }, { action: "none" });
    const system = String(messages[0]?.content ?? "");
    expect(system).toContain("CAMPOS DE LA FICHA");
    expect(system).toContain("- presupuesto (número");
    expect(system).toContain("contado | financiamiento | arrendamiento | por definir");
    expect(system).toContain("monto total que dice poder pagar");
    expect(system).toContain("confirmado por el equipo");
    expect(system).not.toContain("- interno (");
  });
});

describe("030 — turno con historial que termina en saliente", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updates.length = 0;
    timeline.length = 0;
    upsertFicha.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });

  it("el último mensaje enviado al modelo es el aviso del sistema (rol user)", async () => {
    const { ENDS_WITH_OUTBOUND_NOTICE } = await import("@/server/ai/history");
    const messages = await turn(baseProfile, { action: "none" }, [
      { direction: "in", text: "hola" },
      { direction: "in", text: "¿tienen el T03?" },
      { direction: "out", text: "¡Hola! Sí, cuéntame.", aiGenerated: true },
    ]);
    expect(messages.at(-1)).toEqual({ role: "user", content: ENDS_WITH_OUTBOUND_NOTICE });
    expect(messages.at(-2)?.role).toBe("assistant");
    // `none` no escribe nada al cliente.
    expect(timeline).toEqual([]);
  });

  it("el historial que ya termina en el cliente no lleva aviso", async () => {
    const { ENDS_WITH_OUTBOUND_NOTICE } = await import("@/server/ai/history");
    const messages = await turn(baseProfile, { action: "reply", text: "ok" });
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.some((m) => m.content === ENDS_WITH_OUTBOUND_NOTICE)).toBe(false);
  });

  it("el regex de handoff sigue corriendo sobre el último ENTRANTE (no sobre el aviso)", async () => {
    const { chatJson } = await import("@/lib/ai");
    vi.mocked(chatJson).mockClear();
    await turn(baseProfile, { action: "none" }, [
      { direction: "in", text: "quiero hablar con un asesor" },
      { direction: "out", text: "Claro, un momento.", aiGenerated: true },
    ]);
    expect(chatJson).not.toHaveBeenCalled();
    expect(updates.some((u) => u.handoffReason === "cliente")).toBe(true);
    // El valor encolado para este turno no se consumió: no contamina al siguiente.
    vi.mocked(chatJson).mockReset();
  });
});

describe("030 — aviso al cliente cuando escala el patrón de respaldo", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updates.length = 0;
    timeline.length = 0;
    failNextOutbound = false;
    upsertFicha.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });

  async function phraseTurn(profile: object) {
    const { chatJson } = await import("@/lib/ai");
    vi.mocked(chatJson).mockReset();
    selectQueue.push([conversation], [profile]);
    loadHistoryRows.mockResolvedValueOnce([
      { direction: "in", text: "quiero hablar con un humano" },
    ]);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");
    expect(chatJson).not.toHaveBeenCalled();
  }

  it("trato usted: entrega el aviso usted y DESPUÉS escala con 'cliente'", async () => {
    const { HANDOFF_ACK_USTED } = await import("@/server/ai/handoff");
    await phraseTurn({ ...baseProfile, formality: "usted" });
    expect(timeline).toEqual([`out:${HANDOFF_ACK_USTED}`, "handoff:cliente"]);
  });

  it("trato tú (o perfil sin trato): entrega el aviso tú", async () => {
    const { HANDOFF_ACK_TU } = await import("@/server/ai/handoff");
    await phraseTurn({ ...baseProfile, formality: "tu" });
    expect(timeline).toEqual([`out:${HANDOFF_ACK_TU}`, "handoff:cliente"]);
    timeline.length = 0;
    await phraseTurn(baseProfile);
    expect(timeline).toEqual([`out:${HANDOFF_ACK_TU}`, "handoff:cliente"]);
  });

  it("si el envío truena, el handoff 'cliente' ocurre igual y no se propaga", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    failNextOutbound = true;
    await expect(
      phraseTurn({ ...baseProfile, formality: "usted" })
    ).resolves.toBeUndefined();
    expect(timeline).toEqual(["handoff:cliente"]);
    // El log lleva el tipo de error, nunca el texto del cliente.
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("aviso de handoff");
    expect(logged).not.toContain("humano");
    err.mockRestore();
  });

  it("el handoff del MODELO no manda el aviso fijo (usa su despedida)", async () => {
    await turn(baseProfile, {
      action: "handoff",
      reason: "pide humano",
      farewell: "Te paso.",
    });
    expect(timeline).toEqual(["out:Te paso.", "handoff:modelo"]);
  });

  it("el handoff por ERROR del proveedor no manda el aviso", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatJson } = await import("@/lib/ai");
    vi.mocked(chatJson).mockReset();
    vi.mocked(chatJson).mockResolvedValueOnce({
      ok: false,
      error: "provider_error",
      detail: "x",
    });
    selectQueue.push([conversation], [baseProfile], [], []);
    loadHistoryRows.mockResolvedValueOnce([{ direction: "in", text: "hola" }]);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");
    expect(timeline).toEqual(["handoff:error"]);
    err.mockRestore();
  });

  it("el handoff por VENTANA cerrada no manda el aviso (aunque pida humano)", async () => {
    selectQueue.push(
      [
        {
          ...conversation,
          isTest: false,
          lastInboundAt: new Date(Date.now() - 48 * 3600_000),
        },
      ],
      [baseProfile]
    );
    loadHistoryRows.mockResolvedValueOnce([
      { direction: "in", text: "quiero hablar con un humano" },
    ]);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");
    expect(timeline).toEqual(["handoff:ventana"]);
  });
});
