import { describe, expect, it } from "vitest";
import { acceptsOfficeDocs, attachKinds, joinOr } from "@/lib/attach-kinds";
import {
  INSTAGRAM_OUTBOUND_FILES,
  MESSENGER_OUTBOUND_FILES,
  WHATSAPP_OUTBOUND_FILES,
} from "@/lib/outbound-files";

/**
 * 031 — Menú «Adjuntar»: los tipos, formatos y topes salen de las reglas del
 * canal; el `accept` de cada ítem es un subconjunto del del canal.
 */

describe("joinOr", () => {
  it("une con comas y «o»", () => {
    expect(joinOr(["JPG"])).toBe("JPG");
    expect(joinOr(["JPG", "PNG"])).toBe("JPG o PNG");
    expect(joinOr(["A", "B", "C"])).toBe("A, B o C");
    expect(joinOr([])).toBe("");
  });
});

describe("attachKinds", () => {
  it("WhatsApp: foto, documento, video y audio con sus topes", () => {
    const kinds = attachKinds(WHATSAPP_OUTBOUND_FILES);
    expect(kinds.map((k) => [k.label, k.formats, k.maxMb])).toEqual([
      ["Foto", "JPG o PNG", 5],
      ["Documento", "PDF, Word, Excel, PowerPoint, TXT o CSV", 100],
      ["Video", "MP4 o 3GP", 16],
      ["Audio", "OGG, MP3, AAC, AMR o M4A", 16],
    ]);
  });

  it("cada accept es un subconjunto del accept del canal", () => {
    for (const files of [WHATSAPP_OUTBOUND_FILES, INSTAGRAM_OUTBOUND_FILES, MESSENGER_OUTBOUND_FILES]) {
      const channel = new Set(files.accept.split(","));
      for (const k of attachKinds(files)) {
        for (const ext of k.accept.split(",")) expect(channel.has(ext), `${k.kind} ${ext}`).toBe(true);
      }
    }
  });

  it("la foto suma los formatos que el navegador convierte", () => {
    const foto = attachKinds(WHATSAPP_OUTBOUND_FILES, { extraImageAccept: ".webp,.heic" }).find(
      (k) => k.kind === "image"
    );
    expect(foto?.accept).toBe(".jpg,.jpeg,.png,.webp,.heic");
  });

  it("Instagram: documento solo PDF, con su tope", () => {
    const doc = attachKinds(INSTAGRAM_OUTBOUND_FILES).find((k) => k.kind === "document");
    expect(doc).toMatchObject({ formats: "PDF", maxMb: 25, accept: ".pdf" });
    expect(attachKinds(INSTAGRAM_OUTBOUND_FILES).find((k) => k.kind === "image")?.maxMb).toBe(8);
  });

  it("sin archivos del canal, sin ítems", () => {
    expect(attachKinds(null)).toEqual([]);
  });
});

describe("acceptsOfficeDocs", () => {
  it("el pie de .doc/.xls solo donde se aceptan .docx/.xlsx", () => {
    expect(acceptsOfficeDocs(WHATSAPP_OUTBOUND_FILES)).toBe(true);
    expect(acceptsOfficeDocs(MESSENGER_OUTBOUND_FILES)).toBe(true);
    expect(acceptsOfficeDocs(INSTAGRAM_OUTBOUND_FILES)).toBe(false);
    expect(acceptsOfficeDocs(null)).toBe(false);
  });
});
