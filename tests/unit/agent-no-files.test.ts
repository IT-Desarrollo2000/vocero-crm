import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentActionSchema } from "@/server/ai/actions";

/**
 * 018 (FR-813) — El agente IA y el cerebro externo (`/api/bot/*`) NO envían
 * archivos. Decisión del dueño (14-oct-2026): un archivo sale solo de la mano
 * de un humano desde la Bandeja.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("el esquema de acciones no admite adjuntos", () => {
  for (const agenda of [false, true]) {
    const schema = agentActionSchema(agenda);

    it(`acciones de archivo no existen (agenda=${agenda})`, () => {
      for (const action of ["send_file", "send_media", "send_image", "send_document", "attach"]) {
        expect(
          schema.safeParse({ action, url: "https://x/y.pdf", text: "te mando la cotización" })
            .success
        ).toBe(false);
      }
    });

    it(`un reply con attachment se queda en texto: el adjunto se descarta (agenda=${agenda})`, () => {
      const r = schema.safeParse({
        action: "reply",
        text: "Te mando la cotización",
        attachment: { url: "https://evil.example/x.exe", mime: "application/pdf" },
        media: { id: "media1" },
        file: "x.pdf",
      });
      expect(r.success).toBe(true);
      expect(r.success && r.data).toEqual({ action: "reply", text: "Te mando la cotización" });
    });
  }
});

describe("ni el pipeline del agente ni la API del bot alcanzan el envío de archivos", () => {
  it.each([
    "src/server/ai/pipeline.ts",
    "src/server/ai/actions.ts",
    "src/app/api/bot/messages/route.ts",
  ])("%s no referencia sendMediaMessage ni uploadGraphMedia", (rel) => {
    const code = readFileSync(path.join(ROOT, rel), "utf8");
    expect(code).not.toMatch(/\bsendMediaMessage\b/);
    expect(code).not.toMatch(/\buploadGraphMedia\b/);
    expect(code).not.toMatch(/\bsendAttachment\b/);
  });
});
