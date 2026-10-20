import { describe, expect, it } from "vitest";
import { aiMockCompletion } from "@/server/dev/ai-mock";

/**
 * 023 — Marcadores de agenda del ai-mock: `[e2e-agenda <tipo>]` → offer_slots
 * con `type`; `[e2e-reserva <ISO>]` → book_slot. Lo demás no cambia: "quiero
 * agendar" (texto del selftest) sigue siendo una respuesta de eco.
 */

const user = (content: string) =>
  JSON.parse(aiMockCompletion([{ role: "user", content }]));

describe("ai-mock — marcadores de agenda", () => {
  it("[e2e-agenda Servicio] → offer_slots con el tipo", () => {
    expect(user("hola [e2e-agenda Servicio]")).toEqual({
      action: "offer_slots",
      type: "Servicio",
    });
    expect(user("[e2e-agenda Prueba de manejo]").type).toBe("Prueba de manejo");
  });

  it("[e2e-reserva <ISO>] → book_slot con ese instante", () => {
    expect(user("[e2e-reserva 2026-10-22T15:30:00.000Z] gracias")).toEqual({
      action: "book_slot",
      startUtc: "2026-10-22T15:30:00.000Z",
    });
  });

  it("sin marcador, 'quiero agendar' sigue siendo eco", () => {
    expect(user("quiero agendar")).toEqual({
      action: "reply",
      text: "Respuesta de prueba sobre: quiero agendar",
    });
  });
});
