import { describe, expect, it } from "vitest";
import {
  formatImageSize,
  jpegName,
  normalizationSummary,
  normalizeImageFile,
  planImageNormalization,
} from "@/lib/image-normalize";

const MB = 1024 * 1024;
const opts = { maxBytes: 5 * MB };

describe("planImageNormalization", () => {
  it("JPEG/PNG dentro del tope → keep", () => {
    expect(planImageNormalization({ mimeType: "image/jpeg", fileName: "a.jpg", size: MB }, opts)).toEqual({ action: "keep" });
    expect(planImageNormalization({ mimeType: "image/png", fileName: "a.png", size: 5 * MB }, opts)).toEqual({ action: "keep" });
  });

  it("JPEG/PNG por encima del tope → convert (size) con nombre .jpg", () => {
    expect(planImageNormalization({ mimeType: "image/png", fileName: "grande.png", size: 5 * MB + 1 }, opts)).toEqual({
      action: "convert",
      reason: "size",
      outputName: "grande.jpg",
    });
    expect(planImageNormalization({ mimeType: "image/jpeg", fileName: "foto.JPEG", size: 9 * MB }, opts)).toEqual({
      action: "convert",
      reason: "size",
      outputName: "foto.jpg",
    });
  });

  it.each([
    ["image/webp", "foto.webp"],
    ["image/gif", "anim.gif"],
    ["image/heic", "IMG_0001.HEIC"],
    ["image/heif", "x.heif"],
    ["image/bmp", "x.bmp"],
    ["image/avif", "x.avif"],
  ])("%s → convert (format) aunque pese poco", (mimeType, fileName) => {
    const plan = planImageNormalization({ mimeType, fileName, size: 1000 }, opts);
    expect(plan).toEqual({ action: "convert", reason: "format", outputName: jpegName(fileName) });
    expect(plan.action === "convert" && plan.outputName.endsWith(".jpg")).toBe(true);
  });

  it("MIME vacío u octet-stream: decide la extensión", () => {
    expect(planImageNormalization({ mimeType: "", fileName: "IMG_1.heic", size: 10 }, opts)).toMatchObject({ action: "convert", reason: "format", outputName: "IMG_1.jpg" });
    expect(planImageNormalization({ mimeType: "application/octet-stream", fileName: "a.WEBP", size: 10 }, opts)).toMatchObject({ action: "convert", reason: "format" });
    expect(planImageNormalization({ mimeType: "", fileName: "a.png", size: 10 }, opts)).toEqual({ action: "keep" });
    expect(planImageNormalization({ mimeType: "", fileName: "a.png", size: 6 * MB }, opts)).toMatchObject({ action: "convert", reason: "size" });
    expect(planImageNormalization({ mimeType: "", fileName: "sin-extension", size: 10 }, opts)).toEqual({ action: "keep" });
  });

  it.each([
    ["application/pdf", "ficha.pdf", 50 * MB],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", 10],
    ["audio/ogg", "nota.ogg", 10],
    ["video/mp4", "v.mp4", 50 * MB],
    ["image/svg+xml", "logo.svg", 10],
    ["text/plain", "a.txt", 10],
  ])("%s no es imagen convertible → keep", (mimeType, fileName, size) => {
    expect(planImageNormalization({ mimeType, fileName, size }, opts)).toEqual({ action: "keep" });
  });

  it("el MIME manda sobre la extensión cuando es informativo", () => {
    expect(planImageNormalization({ mimeType: "application/pdf", fileName: "raro.webp", size: 10 }, opts)).toEqual({ action: "keep" });
    expect(planImageNormalization({ mimeType: "image/webp", fileName: "foto.png", size: 10 }, opts)).toMatchObject({ action: "convert", outputName: "foto.jpg" });
  });
});

describe("jpegName / formatImageSize / normalizationSummary", () => {
  it("nombres", () => {
    expect(jpegName("foto.webp")).toBe("foto.jpg");
    expect(jpegName("mi.foto.final.HEIC")).toBe("mi.foto.final.jpg");
    expect(jpegName("sinext")).toBe("sinext.jpg");
    expect(jpegName("C:\\fakepath\\a.gif")).toBe("a.jpg");
    expect(jpegName("")).toBe("imagen.jpg");
    expect(jpegName(".oculto")).toBe(".oculto.jpg");
  });

  it("tamaños", () => {
    expect(formatImageSize(5 * MB)).toBe("5 MB");
    expect(formatImageSize(4.72 * MB)).toBe("4.7 MB");
    expect(formatImageSize(820 * 1024)).toBe("820 KB");
  });

  it("resumen", () => {
    const f = new File([new Uint8Array(2 * MB)], "a.jpg", { type: "image/jpeg" });
    expect(normalizationSummary({ file: f, converted: false })).toBeNull();
    expect(normalizationSummary({ file: f, converted: true, reason: "format" })).toBe("convertida a JPG (2 MB)");
    expect(normalizationSummary({ file: f, converted: true, reason: "size" })).toBe("reducida a 2 MB");
  });
});

describe("normalizeImageFile fuera del navegador", () => {
  it("lo que se queda vuelve intacto", async () => {
    const pdf = new File([new Uint8Array(10)], "a.pdf", { type: "application/pdf" });
    const r = await normalizeImageFile(pdf, opts);
    expect(r).toEqual({ file: pdf, converted: false });
  });

  it("sin canvas no lanza: devuelve el original con aviso", async () => {
    const webp = new File([new Uint8Array(10)], "a.webp", { type: "image/webp" });
    const r = await normalizeImageFile(webp, opts);
    expect(r.file).toBe(webp);
    expect(r.converted).toBe(false);
    expect(r.note).toMatch(/JPG o PNG/);
  });
});
