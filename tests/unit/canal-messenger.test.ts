import { describe, expect, it } from "vitest";
import { CHANNEL_ORDER } from "@/lib/channels";
import { parseChannels } from "@/server/channels/enabled";
import {
  capabilitiesFor,
  replyModeFor,
  textFits,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { toInboundText } from "@/server/messenger/ingest";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("017 — Messenger en el catálogo", () => {
  it("se enciende con CHANNELS como cualquier otro canal", () => {
    expect(parseChannels("whatsapp,messenger").has("messenger")).toBe(true);
    expect(parseChannels("whatsapp,instagram").has("messenger")).toBe(false);
    expect(CHANNEL_ORDER).toContain("messenger");
  });

  it("el límite de Messenger es en CARACTERES: un emoji cuenta uno", () => {
    expect(textFits("messenger", "a".repeat(2000))).toBe(true);
    expect(textFits("messenger", "a".repeat(2001))).toBe(false);
    // 2000 emojis son 8000 bytes: con un límite en bytes esto se rechazaría.
    expect(textFits("messenger", "😀".repeat(2000))).toBe(true);
    expect(textFits("messenger", "😀".repeat(2001))).toBe(false);
  });

  it("solo WhatsApp tiene plantillas y adjuntos salientes", () => {
    expect(capabilitiesFor("whatsapp").templates).toBe(true);
    expect(capabilitiesFor("whatsapp").outboundMedia).toBe(true);
    for (const ch of ["instagram", "messenger"] as const) {
      expect(capabilitiesFor(ch).templates).toBe(false);
      expect(capabilitiesFor(ch).outboundMedia).toBe(false);
    }
  });
});

describe("017 — replyModeFor: cómo se puede responder hoy", () => {
  it("dentro de las 24 h es libre en todos los canales", () => {
    for (const ch of CHANNEL_ORDER) {
      expect(replyModeFor(ch, ago(23 * HOUR), now)).toBe("free");
    }
  });

  it("WhatsApp fuera de ventana exige plantilla, sin importar cuánto pasó", () => {
    expect(replyModeFor("whatsapp", ago(25 * HOUR), now)).toBe("template");
    expect(replyModeFor("whatsapp", ago(30 * DAY), now)).toBe("template");
    expect(replyModeFor("whatsapp", null, now)).toBe("template");
  });

  it("Instagram y Messenger: agente humano hasta 7 días, después cerrado", () => {
    for (const ch of ["instagram", "messenger"] as const) {
      expect(replyModeFor(ch, ago(25 * HOUR), now)).toBe("human_agent");
      expect(replyModeFor(ch, ago(7 * DAY - HOUR), now)).toBe("human_agent");
      expect(replyModeFor(ch, ago(7 * DAY + HOUR), now)).toBe("closed");
      // Sin entrantes no hay a quién responder (la persona escribe primero).
      expect(replyModeFor(ch, null, now)).toBe("closed");
    }
  });

  it("el motivo del cierre menciona los 7 días en los canales con etiqueta", () => {
    expect(windowClosedMessage("messenger")).toMatch(/7 días/);
    expect(windowClosedMessage("whatsapp")).toMatch(/plantilla/);
  });
});

describe("017 — toInboundText: qué eventos del webhook son mensajes", () => {
  const base = {
    sender: { id: "psid_1" },
    recipient: { id: "page_1" },
    timestamp: 1_700_000_000_000,
  };

  it("un texto del cliente se ingiere", () => {
    expect(
      toInboundText({ ...base, message: { mid: "m1", text: "hola" } })
    ).toEqual({ psid: "psid_1", mid: "m1", text: "hola", timestamp: 1_700_000_000_000 });
  });

  it("ecos, lecturas, entregas y postbacks se ignoran", () => {
    expect(
      toInboundText({ ...base, message: { mid: "m2", text: "eco", is_echo: true } })
    ).toBeNull();
    expect(toInboundText({ ...base, read: { watermark: 1 } })).toBeNull();
    expect(toInboundText({ ...base, delivery: { mids: ["m1"] } })).toBeNull();
    expect(toInboundText({ ...base, postback: { payload: "X" } })).toBeNull();
  });

  it("un adjunto sin texto, o sin mid, no se ingiere (fuera de alcance)", () => {
    expect(toInboundText({ ...base, message: { mid: "m3" } })).toBeNull();
    expect(toInboundText({ ...base, message: { text: "sin mid" } })).toBeNull();
  });
});
