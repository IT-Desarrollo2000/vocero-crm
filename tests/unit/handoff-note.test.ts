import { beforeEach, describe, expect, it, vi } from "vitest";
import { toHandoffNote, HANDOFF_NOTE_MAX } from "@/server/ai/handoff";
import { handoffNoteFrom } from "@/server/bot/handoff";
import {
  HANDOFF_FALLBACK_LABEL,
  HANDOFF_LABELS,
  handoffLabel,
} from "@/lib/handoff-labels";

/**
 * Nota libre del handoff: el porqué que explica el agente (o el cerebro
 * externo) se guarda en `handoffNote` en vez de perderse, y se limpia al
 * reactivar la IA.
 */

vi.mock("@/lib/ai", () => ({
  chatJson: vi.fn(),
}));

// BD simulada: cola de selects + captura de cada `update().set(valores)`.
const selectQueue: unknown[][] = [];
const updates: Record<string, unknown>[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: unknown) => {
        const chain = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => {
            const chain = {
              returning: () => Promise.resolve([{ id: "cv_x", ...values }]),
              then: (resolve: (v: unknown) => void) =>
                Promise.resolve([{}]).then(resolve),
            };
            return chain;
          },
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          { get: (_t2, col) => `${String(tableName)}.${String(col)}` }
        ),
    }
  ),
}));

const labConversation = {
  id: "cv_lab",
  organizationId: "org_1",
  contactId: "ct_lab",
  isTest: true, // el farewell se persiste en sandbox: jamás toca Graph
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

describe("handoff del agente: el reason libre se guarda como nota", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updates.length = 0;
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  });

  it("acción handoff con reason → handoffReason 'modelo' + handoffNote con el texto", async () => {
    const { chatJson } = await import("@/lib/ai");
    vi.mocked(chatJson).mockResolvedValueOnce({
      ok: true,
      data: {
        action: "handoff",
        reason: "  Pide un descuento mayorista que no puedo autorizar  ",
        farewell: "Te paso con un asesor.",
      },
      raw: "{}",
    });
    selectQueue.push(
      [labConversation],
      [profile],
      [{ id: "msg_1", direction: "in", text: "¿me haces precio por 500 piezas?", createdAt: new Date() }],
      [],
      []
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const handoff = updates.find((u) => u.handoffAt instanceof Date);
    expect(handoff).toBeDefined();
    expect(handoff!.handoffReason).toBe("modelo");
    expect(handoff!.handoffNote).toBe(
      "Pide un descuento mayorista que no puedo autorizar"
    );
  });

  it("acción handoff sin reason → handoffNote null", async () => {
    const { chatJson } = await import("@/lib/ai");
    vi.mocked(chatJson).mockResolvedValueOnce({
      ok: true,
      data: { action: "handoff" },
      raw: "{}",
    });
    selectQueue.push(
      [labConversation],
      [profile],
      [{ id: "msg_1", direction: "in", text: "hola", createdAt: new Date() }],
      [],
      []
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const handoff = updates.find((u) => u.handoffAt instanceof Date);
    expect(handoff).toBeDefined();
    expect(handoff!.handoffReason).toBe("modelo");
    expect(handoff!.handoffNote).toBeNull();
  });
});

describe("reactivar la IA limpia la nota", () => {
  beforeEach(() => {
    updates.length = 0;
  });

  it("updateConversation({ reactivate }) pone handoffAt/Reason/Note en null", async () => {
    const { updateConversation } = await import("@/server/inbox/queries");
    await updateConversation("org_1", "cv_x", { reactivate: true });
    const set = updates[0]!;
    expect(set.handoffAt).toBeNull();
    expect(set.handoffReason).toBeNull();
    expect(set.handoffNote).toBeNull();
    expect(set.aiEnabled).toBe(true);
  });
});

describe("toHandoffNote", () => {
  it("recorta espacios y vacío → null", () => {
    expect(toHandoffNote("  hola  ")).toBe("hola");
    expect(toHandoffNote("   ")).toBeNull();
    expect(toHandoffNote(undefined)).toBeNull();
    expect(toHandoffNote(null)).toBeNull();
  });

  it("corta al tope en vez de rechazar", () => {
    expect(toHandoffNote("x".repeat(2000))).toHaveLength(HANDOFF_NOTE_MAX);
  });
});

describe("handoffNoteFrom (cerebro externo)", () => {
  it("la nota explícita manda", () => {
    expect(handoffNoteFrom("hostilidad", "insultó dos veces")).toBe(
      "insultó dos veces"
    );
  });

  it("motivo del catálogo sin nota → null", () => {
    expect(handoffNoteFrom("hostilidad", undefined)).toBeNull();
    expect(handoffNoteFrom(" Cliente ", undefined)).toBeNull();
    expect(handoffNoteFrom(undefined, undefined)).toBeNull();
  });

  it("motivo fuera del catálogo sin nota → el texto crudo se conserva como nota", () => {
    expect(handoffNoteFrom("porque se enojó", undefined)).toBe(
      "porque se enojó"
    );
  });
});

describe("etiquetas del motivo de handoff", () => {
  it("hostilidad tiene etiqueta propia (no cae al texto genérico)", () => {
    expect(HANDOFF_LABELS.hostilidad).toBeTruthy();
    expect(handoffLabel("hostilidad")).not.toBe(HANDOFF_FALLBACK_LABEL);
  });

  it("todo motivo del enum tiene etiqueta", () => {
    for (const r of [
      "cliente",
      "modelo",
      "error",
      "ventana",
      "hostilidad",
      "manual_reply",
    ]) {
      expect(handoffLabel(r)).not.toBe(HANDOFF_FALLBACK_LABEL);
    }
  });

  it("motivo desconocido o null → texto genérico", () => {
    expect(handoffLabel(null)).toBe(HANDOFF_FALLBACK_LABEL);
    expect(handoffLabel("otro")).toBe(HANDOFF_FALLBACK_LABEL);
  });
});
