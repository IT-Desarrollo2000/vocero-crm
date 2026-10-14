import { describe, expect, it } from "vitest";
import { inspectFile } from "@/server/media/file-policy";
import {
  asciiFileName,
  contentDisposition,
  expiredResponse,
  inspectForServing,
  safeFileHeaders,
} from "@/server/media/serve";
import { mockDeclaredMime, mockMediaBytes } from "@/server/dev/wa-mock-media";

/**
 * 018 — Cómo se sirve un archivo (FR-814) y los bytes del wa-mock (T008).
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF");

function ok(bytes: Uint8Array) {
  const r = inspectFile(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe("cabeceras seguras", () => {
  it("imagen → inline, tipo detectado, nosniff, CSP sandbox, CORP", () => {
    const h = safeFileHeaders({
      inspection: ok(JPEG),
      fileName: "foto.png",
      length: JPEG.byteLength,
      cacheControl: "private, max-age=86400",
    });
    expect(h).toMatchObject({
      "content-type": "image/jpeg",
      "content-length": "10",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, max-age=86400",
    });
  });

  it("PDF → attachment con nombre ASCII saneado y filename* UTF-8", () => {
    const cd = contentDisposition(ok(PDF), 'Cotización "final".pdf');
    expect(cd).toBe(
      "attachment; filename=\"Cotizacion _final_.pdf\"; filename*=UTF-8''Cotizaci%C3%B3n%20%22final%22.pdf"
    );
  });

  it("sin nombre → adjunto.<ext detectada>", () => {
    expect(contentDisposition(ok(PDF), null)).toContain('filename="adjunto.pdf"');
  });

  it("el nombre no puede romper la cabecera ni subir de carpeta", () => {
    expect(asciiFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(asciiFileName("a\r\nb\";.pdf")).toBe("a__b__.pdf");
    expect(asciiFileName("")).toBe("adjunto");
  });

  it("re-inspección al servir: HTML guardado como pdf → 415 blocked", async () => {
    const r = inspectForServing(new TextEncoder().encode("<html><script>x</script>"), {
      fileName: "c.pdf",
      mime: "application/pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(415);
      expect(await r.response.json()).toMatchObject({ error: { code: "blocked" } });
    }
  });

  it("expirado → 410 expired con el aviso de 30 días", async () => {
    const res = expiredResponse();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: {
        code: "expired",
        message: "El archivo se eliminó: los archivos se guardan 30 días",
      },
    });
  });
});

describe("wa-mock con bytes reales (T008)", () => {
  it.each([
    ["media-e2e-img-1", "image/jpeg", "image/jpeg"],
    ["media-e2e-echo-img", "image/jpeg", "image/jpeg"],
    ["media123", "image/jpeg", "image/jpeg"],
    ["media-e2e-pdf-1", "application/pdf", "application/pdf"],
  ])("%s pasa la política con el tipo que declara", (id, declared, detected) => {
    expect(mockDeclaredMime(id)).toBe(declared);
    expect(inspectFile(mockMediaBytes(id), { mime: declared })).toMatchObject({
      ok: true,
      mime: detected,
    });
  });

  it.each(["media-e2e-html-pdf", "media-e2e-exe-1"])("%s se bloquea", (id) => {
    expect(inspectFile(mockMediaBytes(id), { mime: mockDeclaredMime(id) }).ok).toBe(false);
  });
});
