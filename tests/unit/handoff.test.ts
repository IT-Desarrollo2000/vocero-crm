import { describe, expect, it } from "vitest";
import {
  HANDOFF_ACK_TU,
  HANDOFF_ACK_USTED,
  handoffAckText,
  matchesHandoffIntent,
} from "@/server/ai/handoff";

describe("patrón de respaldo de handoff (FR-022 / SC-006)", () => {
  it.each([
    "quiero hablar con un humano",
    "¿puedo hablar con un asesor?",
    "necesito comunicarme con alguien",
    "quiero contactar a una persona real",
    "quiero hablar con alguien por favor",
    "me pasas a un asesor",
    "prefiero atención humana",
    "atencion humana por favor",
  ])("dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(true);
  });

  it.each([
    "somos 4 personas", // el caso canónico que NO debe disparar
    "somos cuatro personas y queremos reservar",
    "¿tienen taladros?",
    "la persona que me atendió ayer fue amable",
    "mi humano favorito es mi hijo",
    "el asesor fiscal ya me cobró", // sin verbo de contacto ni "un asesor"
  ])("NO dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(false);
  });
});

describe("030 — handoffAckText (aviso del patrón de respaldo)", () => {
  it("devuelve exactamente los textos de la spec según el trato", () => {
    expect(handoffAckText("usted")).toBe(
      "Con gusto. Le comunico con un asesor; le responderá por este mismo chat lo antes posible."
    );
    expect(handoffAckText("tu")).toBe(
      "Con gusto. Te comunico con un asesor; te responderá por este mismo chat lo antes posible."
    );
    expect(handoffAckText("usted")).toBe(HANDOFF_ACK_USTED);
    expect(handoffAckText("tu")).toBe(HANDOFF_ACK_TU);
  });
});
