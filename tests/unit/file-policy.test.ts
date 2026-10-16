import { describe, expect, it } from "vitest";
import {
  checkChannelFile,
  inspectFile,
  inspectOutgoing,
  MAX_FILE_BYTES,
  MediaValidationError,
  OOXML_MIME,
  zipEntryNames,
} from "@/server/media/file-policy";
import {
  INSTAGRAM_OUTBOUND_FILES,
  MESSENGER_OUTBOUND_FILES,
  WHATSAPP_OUTBOUND_FILES,
} from "@/lib/outbound-files";
import { makeZip } from "./helpers/zip";

/**
 * 018 — La política de archivos decide por FIRMA (FR-801/802/803). Todos los
 * buffers se construyen aquí: nada de fixtures binarios en el repo.
 */

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const c of p) out.push(c.charCodeAt(0) & 0xff);
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const pad = (n: number) => new Array<number>(n).fill(0);

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], pad(4), [0xff, 0xd9]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad(8));
const GIF = bytes("GIF89a", pad(6));
const WEBP = bytes("RIFF", pad(4), "WEBPVP8 ", pad(4));
const WAV = bytes("RIFF", pad(4), "WAVEfmt ", pad(4));
const PDF = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");

const DOCX = makeZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);

describe("inspectFile — imágenes", () => {
  it.each([
    ["jpeg", JPEG, "image/jpeg", "jpg"],
    ["png", PNG, "image/png", "png"],
    ["gif", GIF, "image/gif", "gif"],
    ["webp", WEBP, "image/webp", "webp"],
  ])("%s por firma, aunque se declare otra cosa", (_n, buf, mime, ext) => {
    const r = inspectFile(buf, { fileName: "foto.pdf", mime: "application/pdf" });
    expect(r).toEqual({ ok: true, mime, kind: "image", ext, inlineSafe: true });
  });

  it("HEIC (ftyp heic) → bloqueado con razón", () => {
    const r = inspectFile(bytes(pad(4), "ftypheic", pad(8)));
    expect(r.ok).toBe(false);
  });

  it("RIFF que no es WEBP ni WAVE (AVI) → bloqueado", () => {
    expect(inspectFile(bytes("RIFF", pad(4), "AVI LIST")).ok).toBe(false);
  });
});

describe("inspectFile — PDF", () => {
  it("PDF limpio → document, descarga (no inline)", () => {
    expect(inspectFile(PDF)).toEqual({
      ok: true,
      mime: "application/pdf",
      kind: "document",
      ext: "pdf",
      inlineSafe: false,
    });
  });

  it.each(["/JavaScript (app.alert(1))", "/JS (x)", "/JS<414141>", "/Launch << /F (cmd.exe) >>"])(
    "PDF con %s → bloqueado",
    (active) => {
      const r = inspectFile(bytes(`%PDF-1.4\n1 0 obj << /OpenAction << /S ${active} >> >>`));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/PDF/);
    }
  );

  it("una palabra que empieza con /JS no dispara (p. ej. /JSON)", () => {
    expect(inspectFile(bytes("%PDF-1.4\n<< /JSONData 1 >>")).ok).toBe(true);
  });
});

describe("inspectFile — Office OOXML", () => {
  it("lee los nombres del directorio central sin descomprimir", () => {
    expect(zipEntryNames(DOCX)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);
  });

  it("docx limpio → mime OOXML de Word", () => {
    expect(inspectFile(DOCX, { fileName: "cotizacion.docx" })).toMatchObject({
      ok: true,
      mime: OOXML_MIME.docx,
      kind: "document",
      ext: "docx",
      inlineSafe: false,
    });
  });

  it("xlsx y pptx", () => {
    expect(inspectFile(makeZip(["[Content_Types].xml", "xl/workbook.xml"]))).toMatchObject({
      ok: true,
      ext: "xlsx",
    });
    expect(
      inspectFile(makeZip(["[Content_Types].xml", "ppt/presentation.xml"]))
    ).toMatchObject({ ok: true, ext: "pptx" });
  });

  it("docx con word/vbaProject.bin → bloqueado por macros", () => {
    const r = inspectFile(
      makeZip(["[Content_Types].xml", "word/document.xml", "word/vbaProject.bin"]),
      { fileName: "cotizacion.docx" }
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/macros/);
  });

  it("vbaProject.bin en cualquier carpeta → bloqueado", () => {
    expect(
      inspectFile(makeZip(["[Content_Types].xml", "xl/workbook.xml", "otra/VBAPROJECT.BIN"])).ok
    ).toBe(false);
  });

  it("extensión habilitada para macros (.xlsm) → bloqueado aunque no se vea el vba", () => {
    const r = inspectFile(makeZip(["[Content_Types].xml", "xl/workbook.xml"]), {
      fileName: "precios.xlsm",
    });
    expect(!r.ok && r.reason).toMatch(/macros/);
  });

  it("zip genérico (sin [Content_Types].xml) → bloqueado como comprimido", () => {
    const r = inspectFile(makeZip(["fotos/a.jpg", "fotos/b.jpg"]), { fileName: "fotos.docx" });
    expect(!r.ok && r.reason).toMatch(/comprimidos/);
  });

  it("zip truncado (sin directorio central) → bloqueado", () => {
    expect(inspectFile(DOCX.subarray(0, 40)).ok).toBe(false);
  });

  it("Office binario antiguo (OLE) → bloqueado con la sugerencia de formato", () => {
    const r = inspectFile(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad(8)), {
      fileName: "viejo.doc",
    });
    expect(!r.ok && r.reason).toMatch(/\.docx\/\.xlsx\/\.pptx/);
  });
});

describe("inspectFile — ejecutables y comprimidos", () => {
  it.each([
    ["MZ (exe)", bytes("MZ", pad(10))],
    ["ELF", bytes([0x7f, 0x45, 0x4c, 0x46], pad(8))],
    ["#! guion", bytes("#!/bin/sh\nrm -rf /\n")],
    ["rar", bytes("Rar!", [0x1a, 0x07, 0x00], pad(4))],
    ["7z", bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], pad(4))],
    ["gzip", bytes([0x1f, 0x8b, 0x08], pad(6))],
  ])("%s → bloqueado aunque se declare .pdf", (_n, buf) => {
    const r = inspectFile(buf, { fileName: "cotizacion.pdf", mime: "application/pdf" });
    expect(r.ok).toBe(false);
  });

  it("archivo vacío → bloqueado", () => {
    expect(inspectFile(new Uint8Array())).toEqual({ ok: false, reason: "El archivo está vacío" });
  });

  it("binario desconocido → bloqueado (lista blanca)", () => {
    expect(inspectFile(bytes([0x00, 0x01, 0x02, 0x03]), { fileName: "x.bin" }).ok).toBe(false);
  });
});

describe("inspectFile — audio y video", () => {
  it.each([
    ["ogg", bytes("OggS", pad(8)), {}, "audio/ogg", "audio"],
    ["mp3 con ID3", bytes("ID3", [3, 0], pad(6)), {}, "audio/mpeg", "audio"],
    ["mp3 sin ID3 (frame sync)", bytes([0xff, 0xfb, 0x90], pad(5)), { mime: "audio/mpeg" }, "audio/mpeg", "audio"],
    ["aac ADTS", bytes([0xff, 0xf1, 0x50], pad(5)), { fileName: "nota.aac" }, "audio/aac", "audio"],
    ["amr", bytes("#!AMR\n", pad(4)), {}, "audio/amr", "audio"],
    ["wav", WAV, {}, "audio/wav", "audio"],
    ["m4a", bytes(pad(4), "ftypM4A ", pad(8)), {}, "audio/mp4", "audio"],
    ["mp4 declarado audio", bytes(pad(4), "ftypisom", pad(8)), { mime: "audio/mp4" }, "audio/mp4", "audio"],
    ["mp4", bytes(pad(4), "ftypisom", pad(8)), {}, "video/mp4", "video"],
    ["3gp", bytes(pad(4), "ftyp3gp5", pad(8)), {}, "video/3gpp", "video"],
    ["mov", bytes(pad(4), "ftypqt  ", pad(8)), {}, "video/quicktime", "video"],
    ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3], pad(8)), {}, "video/webm", "video"],
    ["webm de audio", bytes([0x1a, 0x45, 0xdf, 0xa3], pad(8)), { mime: "audio/webm" }, "audio/webm", "audio"],
  ])("%s", (_n, buf, declared, mime, kind) => {
    expect(inspectFile(buf, declared)).toMatchObject({ ok: true, mime, kind, inlineSafe: true });
  });

  it("frame sync sin pista de audio → no se adivina (bloqueado)", () => {
    expect(inspectFile(bytes([0xff, 0xfb, 0x90], pad(5)), { fileName: "x.bin" }).ok).toBe(false);
  });
});

describe("inspectFile — texto", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("txt y csv UTF-8 → text/plain / text/csv, descarga", () => {
    expect(inspectFile(enc("hola, ¿qué tal?"), { fileName: "nota.txt" })).toEqual({
      ok: true,
      mime: "text/plain",
      kind: "document",
      ext: "txt",
      inlineSafe: false,
    });
    expect(inspectFile(enc("a,b\n1,2"), { fileName: "precios.csv" })).toMatchObject({
      ok: true,
      mime: "text/csv",
      ext: "csv",
    });
    expect(inspectFile(enc("a,b"), { mime: "text/csv" })).toMatchObject({ mime: "text/csv" });
  });

  it.each([
    "<!DOCTYPE html><script>alert(1)</script>",
    "  <html><body>x</body></html>",
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<?xml version="1.0"?><a/>',
    "<script>alert(1)</script>",
    "﻿<html>",
  ])("markup declarado como .txt → bloqueado: %s", (s) => {
    const r = inspectFile(enc(s), { fileName: "nota.txt", mime: "text/plain" });
    expect(!r.ok && r.reason).toMatch(/HTML, SVG ni XML/);
  });

  it("html declarado como html → bloqueado aunque no empiece con etiqueta", () => {
    expect(inspectFile(enc("hola"), { fileName: "pagina.html" }).ok).toBe(false);
    expect(inspectFile(enc("hola"), { mime: "image/svg+xml" }).ok).toBe(false);
  });

  it("UTF-8 inválido o con NUL → bloqueado", () => {
    expect(inspectFile(bytes([0x68, 0xc3, 0x28]), { fileName: "x.txt" }).ok).toBe(false);
    expect(inspectFile(bytes("ho", [0], "la"), { fileName: "x.txt" }).ok).toBe(false);
  });

  it("texto sin extensión ni MIME de texto → bloqueado", () => {
    expect(inspectFile(enc("hola"), { fileName: "programa.js" }).ok).toBe(false);
  });
});

describe("validación de salida (FR-803: tope → firma → canal)", () => {
  const MB = 1024 * 1024;

  it("por encima del tope global → too_large antes de mirar la firma", () => {
    const fake = { byteLength: MAX_FILE_BYTES + 1 } as Uint8Array;
    expect(() => inspectOutgoing(fake, {})).toThrowError(
      expect.objectContaining({ code: "too_large" })
    );
  });

  it("firma bloqueada → unsupported_type con la razón", () => {
    expect(() => inspectOutgoing(bytes("MZ", pad(4)), { fileName: "a.exe" })).toThrowError(
      expect.objectContaining({ code: "unsupported_type", message: expect.stringMatching(/ejecutable/) })
    );
  });

  it("WhatsApp: jpeg ok; png de 6 MB → too_large; webp/gif → 415", () => {
    const jpeg = inspectOutgoing(JPEG, {});
    expect(checkChannelFile(WHATSAPP_OUTBOUND_FILES, jpeg, 1 * MB, "WhatsApp").rule.kind).toBe(
      "image"
    );
    const png = inspectOutgoing(PNG, {});
    expect(() => checkChannelFile(WHATSAPP_OUTBOUND_FILES, png, 6 * MB, "WhatsApp")).toThrowError(
      expect.objectContaining({ code: "too_large" })
    );
    for (const buf of [WEBP, GIF]) {
      expect(() =>
        checkChannelFile(WHATSAPP_OUTBOUND_FILES, inspectOutgoing(buf, {}), 1000, "WhatsApp")
      ).toThrowError(MediaValidationError);
    }
  });

  it("WhatsApp: csv sale como text/plain; docx como documento", () => {
    const csv = inspectOutgoing(new TextEncoder().encode("a,b"), { fileName: "p.csv" });
    const r = checkChannelFile(WHATSAPP_OUTBOUND_FILES, csv, 3, "WhatsApp");
    expect(r.inspection.mime).toBe("text/csv");
    expect(r.sendMime).toBe("text/plain");
    const docx = inspectOutgoing(DOCX, { fileName: "c.docx" });
    expect(checkChannelFile(WHATSAPP_OUTBOUND_FILES, docx, 1000, "WhatsApp").rule.kind).toBe(
      "document"
    );
  });

  it("Instagram: docx → 415 con el mensaje del canal; pdf ok", () => {
    const docx = inspectOutgoing(DOCX, { fileName: "c.docx" });
    expect(() =>
      checkChannelFile(INSTAGRAM_OUTBOUND_FILES, docx, 1000, "Instagram")
    ).toThrowError(
      expect.objectContaining({
        code: "unsupported_type",
        message: "Instagram solo acepta imágenes (JPG/PNG), PDF, audio (AAC/M4A/WAV) y video (MP4/MOV/WEBM)",
      })
    );
    const pdf = inspectOutgoing(PDF, {});
    expect(checkChannelFile(INSTAGRAM_OUTBOUND_FILES, pdf, 1000, "Instagram").sendMime).toBe(
      "application/pdf"
    );
  });

  it("Instagram: wav/mp4/mov/webm entran (25 MB); mp3 y ogg se bloquean antes de Meta", () => {
    const MP4 = bytes(pad(4), "ftypisom", pad(4));
    const MOV = bytes(pad(4), "ftypqt  ", pad(4));
    const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], pad(8));
    const kinds = [
      [WAV, "audio"],
      [MP4, "video"],
      [MOV, "video"],
      [WEBM, "video"],
    ] as const;
    for (const [buf, kind] of kinds) {
      const r = checkChannelFile(INSTAGRAM_OUTBOUND_FILES, inspectOutgoing(buf, {}), 20 * MB, "Instagram");
      expect(r.rule.kind).toBe(kind);
    }
    expect(() =>
      checkChannelFile(INSTAGRAM_OUTBOUND_FILES, inspectOutgoing(WAV, {}), 26 * MB, "Instagram")
    ).toThrowError(expect.objectContaining({ code: "too_large" }));
    for (const buf of [bytes("ID3", pad(8)), bytes("OggS", pad(8))]) {
      expect(() =>
        checkChannelFile(INSTAGRAM_OUTBOUND_FILES, inspectOutgoing(buf, {}), 1000, "Instagram")
      ).toThrowError(expect.objectContaining({ code: "unsupported_type" }));
    }
  });

  it("Messenger: imagen de 20 MB cabe (25 MB); canal sin archivos → 415", () => {
    const jpeg = inspectOutgoing(JPEG, {});
    expect(checkChannelFile(MESSENGER_OUTBOUND_FILES, jpeg, 20 * MB, "Messenger").rule.kind).toBe(
      "image"
    );
    expect(() => checkChannelFile(null, jpeg, 10, "Instagram")).toThrowError(
      expect.objectContaining({ code: "unsupported_type" })
    );
  });
});
