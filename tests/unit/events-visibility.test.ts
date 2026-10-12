import { describe, expect, it } from "vitest";
import type { SseEvent } from "@/server/events/bus";
import { canReceive } from "@/server/events/visibility";

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
