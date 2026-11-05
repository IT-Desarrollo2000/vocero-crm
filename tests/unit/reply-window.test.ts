import { describe, expect, it } from "vitest";
import { replyWindowBar } from "@/lib/reply-window";

/** 031 — Barra «Puedes escribirle libremente … más» del compositor. */

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("replyWindowBar", () => {
  it("WhatsApp dentro de las 24 h: lo que queda y la fracción", () => {
    const bar = replyWindowBar(
      { channel: "whatsapp", replyMode: "free", lastInboundAt: ago(3 * H), windowRemainingMs: 0 },
      NOW
    );
    expect(bar).toEqual({ kind: "free", remainingMs: 21 * H, fraction: 21 / 24, low: false });
  });

  it("menos de 2 h: tono de aviso", () => {
    const bar = replyWindowBar(
      { channel: "whatsapp", replyMode: "free", lastInboundAt: ago(23 * H), windowRemainingMs: 0 },
      NOW
    );
    expect(bar?.low).toBe(true);
    expect(bar?.remainingMs).toBe(H);
  });

  it("sin entrante usa el windowRemainingMs del DTO", () => {
    const bar = replyWindowBar(
      { channel: "whatsapp", replyMode: "free", lastInboundAt: null, windowRemainingMs: 5 * H },
      NOW
    );
    expect(bar?.remainingMs).toBe(5 * H);
  });

  it("Instagram como agente humano: lo que queda de los 7 días", () => {
    const bar = replyWindowBar(
      { channel: "instagram", replyMode: "human_agent", lastInboundAt: ago(48 * H), windowRemainingMs: 0 },
      NOW
    );
    expect(bar?.kind).toBe("human_agent");
    expect(bar?.remainingMs).toBe(5 * 24 * H);
    expect(bar?.fraction).toBeCloseTo(5 / 7);
  });

  it("ventana cerrada o con plantilla: sin barra", () => {
    expect(
      replyWindowBar(
        { channel: "whatsapp", replyMode: "template", lastInboundAt: ago(30 * H), windowRemainingMs: 0 },
        NOW
      )
    ).toBeNull();
    expect(
      replyWindowBar(
        { channel: "instagram", replyMode: "closed", lastInboundAt: ago(200 * H), windowRemainingMs: 0 },
        NOW
      )
    ).toBeNull();
  });
});
