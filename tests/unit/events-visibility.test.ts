import { describe, expect, it, vi } from "vitest";
import type { SseEvent } from "@/server/events/bus";
import { canReceive, decideDelivery } from "@/server/events/visibility";

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

  it("Vendedor: lab.run → drop; booking.updated → deliver", async () => {
    expect(await decideDelivery(labRun, seller, never)).toEqual({ kind: "drop" });
    expect(await decideDelivery(booking, seller, never)).toEqual({ kind: "deliver" });
  });
});
