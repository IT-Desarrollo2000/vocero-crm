import { describe, expect, it, vi } from "vitest";
import { ingestInboundBatch, type IngestResult } from "@/server/inbox/ingest";

/**
 * 018 — Un mensaje de Messenger/Instagram con varios adjuntos se ingiere como
 * varios mensajes, pero dispara UN solo turno del agente, después del último
 * (con todos ya en la BD). Antes cada ítem disparaba el suyo: con un debounce
 * corto (`AGENT_COALESCE_MS=0`) salían dos respuestas de la IA (medido en
 * vivo). Verificado también en el self-test E2E.
 */

type Item = Parameters<typeof ingestInboundBatch>[0][number];

const item = (id: string): Item => ({
  organizationId: "org_1",
  identity: {
    identity: "fb:psid_1",
    channel: "messenger",
    phone: null,
    waUserId: null,
    profileName: null,
  },
  waMessageId: id,
  type: "image",
  text: null,
  timestamp: "1700000000",
});

function harness(results: IngestResult[]) {
  const order: string[] = [];
  let i = 0;
  const ingest = vi.fn(async (input: Item & { skipAgentTurn?: boolean }) => {
    order.push(`ingest:${input.waMessageId}`);
    return results[i++]!;
  });
  const runAgent = vi.fn(async (conversationId: string) => {
    order.push(`agent:${conversationId}`);
  });
  return { ingest, runAgent, order };
}

describe("ingestInboundBatch (018)", () => {
  it("3 adjuntos nuevos → 3 ingestas sin turno propio y UN turno al final", async () => {
    const h = harness([
      { conversationId: "cv_1", inserted: true },
      { conversationId: "cv_1", inserted: true },
      { conversationId: "cv_1", inserted: true },
    ]);
    await ingestInboundBatch([item("fb_m"), item("fb_m#1"), item("fb_m#2")], h);
    expect(h.ingest).toHaveBeenCalledTimes(3);
    for (const call of h.ingest.mock.calls) expect(call[0].skipAgentTurn).toBe(true);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["ingest:fb_m", "ingest:fb_m#1", "ingest:fb_m#2", "agent:cv_1"]);
  });

  it("re-entrega (todos duplicados) → ningún turno", async () => {
    const h = harness([
      { conversationId: "cv_1", inserted: false },
      { conversationId: "cv_1", inserted: false },
    ]);
    await ingestInboundBatch([item("fb_m"), item("fb_m#1")], h);
    expect(h.runAgent).not.toHaveBeenCalled();
  });

  it("re-entrega parcial (alguno nuevo) → un turno", async () => {
    const h = harness([
      { conversationId: "cv_1", inserted: false },
      { conversationId: "cv_1", inserted: true },
    ]);
    await ingestInboundBatch([item("fb_m"), item("fb_m#1")], h);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent).toHaveBeenCalledWith("cv_1");
  });

  it("lote vacío → nada", async () => {
    const h = harness([]);
    await ingestInboundBatch([], h);
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();
  });
});
