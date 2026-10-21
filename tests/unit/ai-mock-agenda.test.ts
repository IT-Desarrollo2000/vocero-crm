import { describe, expect, it } from "vitest";
import {
  AI_MOCK_ATTENTION_HOURS,
  AI_MOCK_INVENTED_SLOTS,
  AI_MOCK_PRICE_REPLY,
  aiMockCompletion,
} from "@/server/dev/ai-mock";

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

/**
 * 025 — Marcadores SIN ISO: el mock lee el prompt (calendario y HORARIOS
 * OFRECIDOS) como lo haría un modelo real.
 */
const SYSTEM = [
  "Eres X",
  "AGENDA:",
  "Hoy: miércoles 21 oct 2026 12:24 (America/Mexico_City) = 2026-10-21",
  "Próximos días: jue 22=2026-10-22, vie 23=2026-10-23, sáb 24=2026-10-24, dom 25=2026-10-25",
  'HORARIOS OFRECIDOS (vigentes en esta conversación; reserva con book_slot y "slot" = …):',
  "* 2026-10-23 10:00 (vie) — Prueba de manejo",
  "- 2026-10-23 11:00 (vie) — Prueba de manejo",
  "* 2026-10-23 11:00 (vie) — Prueba de manejo",
  "- 2026-10-24 15:00 (sáb) — Prueba de manejo",
  "Etapas del pipeline disponibles: Nuevo",
].join("\n");

const turn = (...users: string[]) =>
  JSON.parse(
    aiMockCompletion([
      { role: "system", content: SYSTEM },
      { role: "user", content: "hola" },
      { role: "assistant", content: '{"action":"reply","text":"hola"}' },
      ...users.map((content) => ({ role: "user", content })),
    ])
  );

describe("ai-mock — marcadores 025 (sin ISO)", () => {
  it("[e2e-dia viernes <tipo>] resuelve la fecha leyendo 'Próximos días' (vie 23, no 24)", () => {
    expect(turn("[e2e-dia viernes Prueba de manejo]")).toEqual({
      action: "offer_slots",
      type: "Prueba de manejo",
      date: "2026-10-23",
    });
    expect(turn("[e2e-dia sábado Servicio]").date).toBe("2026-10-24");
    expect(turn("[e2e-dia 2026-10-25 Servicio]").date).toBe("2026-10-25");
  });

  it("sin calendario en el prompt no inventa la fecha", () => {
    const out = JSON.parse(
      aiMockCompletion([{ role: "user", content: "[e2e-dia viernes Servicio]" }])
    );
    expect(out).toEqual({ action: "offer_slots", type: "Servicio" });
  });

  it("[e2e-elige 11] → la clave marcada con * de esa hora", () => {
    expect(turn("[e2e-elige 11]")).toEqual({ action: "book_slot", slot: "2026-10-23 11:00" });
    expect(turn("[e2e-elige 10:00]")).toEqual({ action: "book_slot", slot: "2026-10-23 10:00" });
  });

  it("[e2e-elige-con-precio 11] → book_slot con la clave y el precio en reply (B1)", () => {
    expect(turn("[e2e-elige-con-precio 11]")).toEqual({
      action: "book_slot",
      slot: "2026-10-23 11:00",
      reply: AI_MOCK_PRICE_REPLY,
    });
  });

  it("sin * para esa hora, cualquier línea con esa hora", () => {
    expect(turn("[e2e-elige 15]")).toEqual({ action: "book_slot", slot: "2026-10-24 15:00" });
  });

  it("hora no ofrecida → clave inexistente del MISMO día (para la re-oferta)", () => {
    expect(turn("[e2e-elige 23:45]")).toEqual({ action: "book_slot", slot: "2026-10-23 23:45" });
  });

  it("coalescido: mira todos los mensajes nuevos del cliente, no solo el último", () => {
    expect(turn("[e2e-elige 11]", "¿y cuánto cuesta?")).toEqual({
      action: "book_slot",
      slot: "2026-10-23 11:00",
    });
  });

  it("[e2e-inventa] y [e2e-horario-atencion] → replies fijos", () => {
    expect(turn("[e2e-inventa]")).toEqual({ action: "reply", text: AI_MOCK_INVENTED_SLOTS });
    expect(turn("[e2e-horario-atencion]")).toEqual({
      action: "reply",
      text: AI_MOCK_ATTENTION_HOURS,
    });
  });

  it("un marcador de un turno ya respondido no se repite", () => {
    const out = JSON.parse(
      aiMockCompletion([
        { role: "system", content: SYSTEM },
        { role: "user", content: "[e2e-elige 11]" },
        { role: "assistant", content: '{"action":"book_slot"}' },
        { role: "user", content: "gracias" },
      ])
    );
    expect(out.action).toBe("reply");
  });
});
