import { describe, expect, it, vi } from "vitest";
import type { SseEvent } from "@/server/events/bus";
import {
  canReceive,
  createDeliveryQueue,
  decideDelivery,
} from "@/server/events/visibility";

/** `/api/events` (dev-tasks/00, T-00-12): `lab.run` solo al Propietario. */

const labRun: SseEvent = {
  type: "lab.run",
  data: { runId: "run_1", status: "running", progress: { done: 1, total: 5 } },
};
const message: SseEvent = {
  type: "message.new",
  data: { conversationId: "cv_1", message: {} },
};

describe("visibilidad de eventos SSE por rol", () => {
  it("el Propietario recibe lab.run", () => {
    expect(canReceive(labRun, { role: "owner" })).toBe(true);
  });

  it("el Vendedor NO recibe lab.run", () => {
    expect(canReceive(labRun, { role: "member" })).toBe(false);
  });

  it("los demás eventos llegan a ambos roles", () => {
    expect(canReceive(message, { role: "member" })).toBe(true);
    expect(canReceive(message, { role: "owner" })).toBe(true);
  });
});

/** 09 (RF-09-09): decisión deliver | rewrite | drop con `canSee` inyectado. */
describe("decideDelivery — asignación", () => {
  const status: SseEvent = {
    type: "message.status",
    data: { conversationId: "cv_1", messageId: "msg_1", status: "read" },
  };
  const updated: SseEvent = {
    type: "conversation.updated",
    data: { conversation: { id: "cv_1" } },
  };
  const booking: SseEvent = { type: "booking.updated", data: { bookingId: "bk_1" } };
  const seller = { role: "member" as const };
  const never = {
    canSee: vi.fn(async (_id: string): Promise<boolean> => {
      throw new Error("no debe consultarse");
    }),
  };

  it("Propietario: todo deliver, sin consultar la BD", async () => {
    for (const e of [labRun, message, status, updated, booking]) {
      expect(await decideDelivery(e, { role: "owner" }, never)).toEqual({ kind: "deliver" });
    }
    expect(never.canSee).not.toHaveBeenCalled();
  });

  it("Vendedor: message.new / message.status según canSee(conversationId)", async () => {
    const canSee = vi.fn(async (id: string) => id === "cv_1");
    expect(await decideDelivery(message, seller, { canSee })).toEqual({ kind: "deliver" });
    expect(await decideDelivery(status, seller, { canSee })).toEqual({ kind: "deliver" });
    expect(canSee).toHaveBeenCalledWith("cv_1");

    const ajeno: SseEvent = { type: "message.new", data: { conversationId: "cv_2", message: {} } };
    expect(await decideDelivery(ajeno, seller, { canSee })).toEqual({ kind: "drop" });
  });

  it("Vendedor: si canSee lanza (BD caída) → drop, sin rechazar", async () => {
    const canSee = vi.fn(async (_id: string): Promise<boolean> => {
      throw new Error("timeout");
    });
    await expect(decideDelivery(message, seller, { canSee })).resolves.toEqual({ kind: "drop" });
  });

  it("Vendedor: conversation.updated se reescribe SIEMPRE a { conversation: { id } }", async () => {
    // Un publicador que mande de más: se recorta igual.
    const gordo = {
      type: "conversation.updated",
      data: { conversation: { id: "cv_9", handoffNote: "secreto", contact: { phone: "52" } } },
    } as unknown as SseEvent;
    expect(await decideDelivery(gordo, seller, never)).toEqual({
      kind: "rewrite",
      event: { type: "conversation.updated", data: { conversation: { id: "cv_9" } } },
    });
    expect(never.canSee).not.toHaveBeenCalled();
  });

  it("Vendedor: conversation.updated sin id → drop", async () => {
    const roto = { type: "conversation.updated", data: { conversation: {} } } as unknown as SseEvent;
    expect(await decideDelivery(roto, seller, never)).toEqual({ kind: "drop" });
  });

  it("05: conversation.handoff — Propietario deliver; Vendedor según canSee (misma regla que message.new)", async () => {
    const handoff = (conversationId: string): SseEvent => ({
      type: "conversation.handoff",
      data: { conversationId, reason: "cliente", handoffAt: "2026-10-12T18:00:00.000Z" },
    });
    expect(await decideDelivery(handoff("cv_2"), { role: "owner" }, never)).toEqual({
      kind: "deliver",
    });

    const canSee = vi.fn(async (id: string) => id === "cv_1");
    expect(await decideDelivery(handoff("cv_1"), seller, { canSee })).toEqual({ kind: "deliver" });
    expect(await decideDelivery(handoff("cv_2"), seller, { canSee })).toEqual({ kind: "drop" });
    expect(canSee).toHaveBeenCalledWith("cv_2");

    const caida = vi.fn(async (_id: string): Promise<boolean> => {
      throw new Error("timeout");
    });
    await expect(decideDelivery(handoff("cv_1"), seller, { canSee: caida })).resolves.toEqual({
      kind: "drop",
    });
  });

  it("Vendedor: lab.run → drop; booking.updated → deliver", async () => {
    expect(await decideDelivery(labRun, seller, never)).toEqual({ kind: "drop" });
    expect(await decideDelivery(booking, seller, never)).toEqual({ kind: "deliver" });
  });
});

/**
 * 09 (T-09-08): la cola por conexión de `/api/events` — orden de llegada
 * aunque la consulta de un evento tarde más que la del siguiente, y un fallo
 * de BD descarta ESE evento sin trabar la cola.
 */
describe("createDeliveryQueue — orden y degradación", () => {
  const seller = { role: "member" as const };
  const msg = (conversationId: string, n: number): SseEvent => ({
    type: "message.new",
    data: { conversationId, message: { n } },
  });
  const tag = (e: SseEvent) =>
    e.type === "message.new"
      ? `new:${(e.data.message as { n: number }).n}`
      : e.type === "message.status"
        ? `status:${e.data.messageId}`
        : e.type;

  it("entrega en el orden de llegada aunque la primera decisión tarde más", async () => {
    const sent: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const canSee = vi.fn(async (id: string) => {
      if (id === "cv_lento") await firstGate;
      return true;
    });
    const q = createDeliveryQueue({ viewer: seller, deps: { canSee }, send: (e) => sent.push(tag(e)) });

    q.push(msg("cv_lento", 1));
    q.push({
      type: "message.status",
      data: { conversationId: "cv_rapido", messageId: "msg_2", status: "read" },
    });
    q.push(msg("cv_rapido", 3));
    // Deja correr microtareas: nada sale mientras el primero espera su consulta.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);

    releaseFirst();
    await q.idle();
    expect(sent).toEqual(["new:1", "status:msg_2", "new:3"]);
  });

  it("si la consulta lanza, se descarta ese evento y los siguientes siguen saliendo", async () => {
    const sent: string[] = [];
    const canSee = vi.fn(async (id: string) => {
      if (id === "cv_roto") throw new Error("connection terminated");
      return id !== "cv_ajeno";
    });
    const q = createDeliveryQueue({ viewer: seller, deps: { canSee }, send: (e) => sent.push(tag(e)) });

    q.push(msg("cv_roto", 1));
    q.push(msg("cv_ajeno", 2));
    q.push(msg("cv_mio", 3));
    q.push({ type: "conversation.updated", data: { conversation: { id: "cv_ajeno" } } });
    await q.idle();
    expect(sent).toEqual(["new:3", "conversation.updated"]);
  });

  it("un send que lanza (stream cerrado) no traba la cola", async () => {
    const sent: string[] = [];
    let first = true;
    const q = createDeliveryQueue({
      viewer: { role: "owner" },
      deps: { canSee: async () => true },
      send: (e) => {
        if (first) {
          first = false;
          throw new Error("enqueue sobre stream cerrado");
        }
        sent.push(tag(e));
      },
    });
    q.push(msg("cv_1", 1));
    q.push(msg("cv_1", 2));
    await q.idle();
    expect(sent).toEqual(["new:2"]);
  });

  it("reescribe conversation.updated a { id } y descarta lab.run para el Vendedor", async () => {
    const sent: SseEvent[] = [];
    const q = createDeliveryQueue({
      viewer: seller,
      deps: { canSee: async () => true },
      send: (e) => sent.push(e),
    });
    q.push(labRun);
    q.push({
      type: "conversation.updated",
      data: { conversation: { id: "cv_7", handoffNote: "x" } },
    } as unknown as SseEvent);
    await q.idle();
    expect(sent).toEqual([
      { type: "conversation.updated", data: { conversation: { id: "cv_7" } } },
    ]);
  });

  it("tras close() no consulta ni envía nada más", async () => {
    const sent: string[] = [];
    const canSee = vi.fn(async () => true);
    const q = createDeliveryQueue({ viewer: seller, deps: { canSee }, send: (e) => sent.push(tag(e)) });
    q.close();
    q.push(msg("cv_1", 1));
    await q.idle();
    expect(sent).toEqual([]);
    expect(canSee).not.toHaveBeenCalled();
  });
});
