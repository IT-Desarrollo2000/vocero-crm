import { describe, expect, it } from "vitest";
import { CHANNEL_ORDER } from "@/lib/channels";
import { parseChannels } from "@/server/channels/enabled";
import {
  capabilitiesFor,
  replyModeFor,
  textFits,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { toInboundMessage } from "@/server/messenger/ingest";

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

  it("solo WhatsApp tiene plantillas, ubicación y contactos salientes", () => {
    expect(capabilitiesFor("whatsapp").templates).toBe(true);
    expect(capabilitiesFor("whatsapp").outboundStructured).toBe(true);
    for (const ch of ["instagram", "messenger"] as const) {
      expect(capabilitiesFor(ch).templates).toBe(false);
      expect(capabilitiesFor(ch).outboundStructured).toBe(false);
    }
  });

  it("018 — matriz de archivos salientes por canal (FR-804)", () => {
    const mimes = (ch: "whatsapp" | "instagram" | "messenger") =>
      (capabilitiesFor(ch).outboundFiles?.rules ?? []).flatMap((r) => r.mimes);
    const max = (ch: "whatsapp" | "instagram" | "messenger", kind: string) =>
      capabilitiesFor(ch).outboundFiles?.rules.find((r) => r.kind === kind)?.maxBytes;
    const MB = 1024 * 1024;

    expect(max("whatsapp", "image")).toBe(5 * MB);
    expect(max("whatsapp", "document")).toBe(100 * MB);
    expect(max("whatsapp", "audio")).toBe(16 * MB);
    expect(capabilitiesFor("whatsapp").outboundFiles?.sendMimeAs?.["text/csv"]).toBe(
      "text/plain"
    );

    expect(max("messenger", "image")).toBe(25 * MB);
    expect(max("messenger", "video")).toBe(25 * MB);
    expect(mimes("messenger")).toContain("text/csv");

    // Instagram (doc de Meta): imágenes 8 MB, SOLO PDF como archivo y
    // audio/video 25 MB, con los MIME que la política detecta por firma.
    expect(max("instagram", "image")).toBe(8 * MB);
    expect(max("instagram", "document")).toBe(25 * MB);
    expect(max("instagram", "audio")).toBe(25 * MB);
    expect(max("instagram", "video")).toBe(25 * MB);
    expect(mimes("instagram")).toEqual([
      "image/jpeg",
      "image/png",
      "application/pdf",
      "audio/aac",
      "audio/mp4",
      "audio/wav",
      "video/mp4",
      "video/quicktime",
      "video/webm",
    ]);
    expect(capabilitiesFor("instagram").outboundFiles?.accept).toBe(
      ".jpg,.jpeg,.png,.pdf,.aac,.m4a,.wav,.mp4,.mov,.webm"
    );

    // Ningún canal envía webp/gif (solo recepción).
    for (const ch of ["whatsapp", "instagram", "messenger"] as const) {
      expect(mimes(ch)).not.toContain("image/webp");
      expect(mimes(ch)).not.toContain("image/gif");
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

describe("017 — toInboundMessage: qué eventos del webhook son mensajes", () => {
  const base = {
    sender: { id: "psid_1" },
    recipient: { id: "page_1" },
    timestamp: 1_700_000_000_000,
  };

  it("un texto del cliente se ingiere", () => {
    expect(
      toInboundMessage({ ...base, message: { mid: "m1", text: "hola" } })
    ).toEqual({
      psid: "psid_1",
      mid: "m1",
      items: [{ idSuffix: "", type: "text", text: "hola", media: null }],
      timestamp: 1_700_000_000_000,
    });
  });

  it("ecos, lecturas, entregas y postbacks se ignoran", () => {
    expect(
      toInboundMessage({ ...base, message: { mid: "m2", text: "eco", is_echo: true } })
    ).toBeNull();
    expect(toInboundMessage({ ...base, read: { watermark: 1 } })).toBeNull();
    expect(toInboundMessage({ ...base, delivery: { mids: ["m1"] } })).toBeNull();
    expect(toInboundMessage({ ...base, postback: { payload: "X" } })).toBeNull();
  });

  it("018 — un adjunto sin texto SÍ se ingiere (antes se perdía)", () => {
    const r = toInboundMessage({
      ...base,
      message: {
        mid: "m3",
        attachments: [
          { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/foto.jpg?oh=1" } },
        ],
      },
    });
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]).toMatchObject({
      idSuffix: "",
      type: "image",
      text: null,
      media: {
        kind: "image",
        sourceUrl: "https://scontent.xx.fbcdn.net/v/foto.jpg?oh=1",
        mimeType: null,
        fetchStatus: "pending",
        waMediaId: null,
      },
    });
  });

  it("sin mid, o sin texto ni adjuntos, no se ingiere", () => {
    expect(toInboundMessage({ ...base, message: { mid: "m3" } })).toBeNull();
    expect(toInboundMessage({ ...base, message: { mid: "m3", attachments: [] } })).toBeNull();
    expect(toInboundMessage({ ...base, message: { text: "sin mid" } })).toBeNull();
  });
});
