import { describe, expect, it } from "vitest";
import {
  CATALOG_DOCUMENT_MIMES,
  CATALOG_IMAGE_MIMES,
  CATALOG_LIMITS,
  catalogBatchSchema,
  type CatalogFileDto,
  catalogFileUrl,
  type CatalogProductDto,
  type CatalogVariantDto,
  categoryPatchSchema,
  defaultShortcutsFor,
  fileCompatibility,
  fileKindFor,
  filesForAttach,
  filesForVariant,
  productCreateSchema,
  productDetailsText,
  productPatchSchema,
  SHORTCUT_CODE_MAX,
  variantCreateSchema,
} from "@/lib/catalog";
import {
  INSTAGRAM_OUTBOUND_FILES,
  MESSENGER_OUTBOUND_FILES,
  WHATSAPP_OUTBOUND_FILES,
} from "@/lib/outbound-files";
import { QUICK_REPLY_LIMITS } from "@/lib/quick-replies";
import { inspectOutgoing, OOXML_MIME } from "@/server/media/file-policy";
import { makeZip } from "./helpers/zip";

/**
 * 019 — Contratos puros del catálogo (`src/lib/catalog.ts`): los usan el
 * store, el envío, la página Catálogo y el compositor.
 */

const MB = 1024 * 1024;

function file(p: Partial<CatalogFileDto> & { id: string }): CatalogFileDto {
  return {
    productId: "prd_1",
    variantId: null,
    kind: "image",
    mimeType: "image/jpeg",
    fileName: `${p.id}.jpg`,
    size: 1000,
    position: 0,
    url: catalogFileUrl(p.id),
    ...p,
  };
}

function variant(p: Partial<CatalogVariantDto> & { id: string }): CatalogVariantDto {
  return {
    productId: "prd_1",
    name: p.id,
    code: null,
    price: null,
    attributes: [],
    active: true,
    position: 0,
    ...p,
  };
}

function product(p: Partial<CatalogProductDto> = {}): CatalogProductDto {
  return {
    id: "prd_1",
    categoryId: null,
    name: "Tiguan",
    code: "T03",
    price: "desde $589,900",
    description: null,
    attributes: [],
    active: true,
    position: 0,
    variants: [],
    files: [],
    ...p,
  };
}

describe("fileKindFor", () => {
  it("JPEG/PNG → image; PDF, Office, txt y csv → document", () => {
    expect(fileKindFor("image/jpeg")).toBe("image");
    expect(fileKindFor("image/png")).toBe("image");
    expect(fileKindFor("application/pdf")).toBe("document");
    expect(fileKindFor(OOXML_MIME.docx)).toBe("document");
    expect(fileKindFor(OOXML_MIME.xlsx)).toBe("document");
    expect(fileKindFor(OOXML_MIME.pptx)).toBe("document");
    expect(fileKindFor("text/plain")).toBe("document");
    expect(fileKindFor("text/csv; charset=utf-8")).toBe("document");
  });

  it("lo demás no entra al catálogo", () => {
    for (const m of ["image/gif", "image/webp", "audio/ogg", "video/mp4", "application/zip", ""]) {
      expect(fileKindFor(m)).toBeNull();
    }
  });

  it("en sincronía con lo que DETECTA inspectOutgoing (file-policy)", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const cases: Array<[Uint8Array, string, "image" | "document" | null]> = [
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "a.jpg", "image"],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "a.png", "image"],
      [enc("%PDF-1.7\n%%EOF"), "a.pdf", "document"],
      [makeZip(["[Content_Types].xml", "word/document.xml"]), "a.docx", "document"],
      [makeZip(["[Content_Types].xml", "xl/workbook.xml"]), "a.xlsx", "document"],
      [makeZip(["[Content_Types].xml", "ppt/presentation.xml"]), "a.pptx", "document"],
      [enc("hola"), "a.txt", "document"],
      [enc("a,b\n1,2"), "a.csv", "document"],
      [enc("GIF89a..."), "a.gif", null],
    ];
    for (const [bytes, fileName, kind] of cases) {
      const detected = inspectOutgoing(bytes, { fileName });
      expect(fileKindFor(detected.mime), fileName).toBe(kind);
    }
    // Y las listas replicadas son exactamente las de la matriz de salida.
    expect([...CATALOG_IMAGE_MIMES].sort()).toEqual(
      WHATSAPP_OUTBOUND_FILES.rules.find((r) => r.kind === "image")!.mimes.slice().sort()
    );
    expect([...CATALOG_DOCUMENT_MIMES].sort()).toEqual(
      WHATSAPP_OUTBOUND_FILES.rules.find((r) => r.kind === "document")!.mimes.slice().sort()
    );
  });
});

describe("filesForAttach / filesForVariant", () => {
  const p = product({
    variants: [
      variant({ id: "pvar_b", position: 2 }),
      variant({ id: "pvar_a", position: 1 }),
      variant({ id: "pvar_off", position: 0, active: false }),
    ],
    files: [
      file({ id: "pf_doc_b", variantId: "pvar_b", kind: "document", mimeType: "application/pdf", position: 0 }),
      file({ id: "pf_img2", position: 2 }),
      file({ id: "pf_doc_a2", variantId: "pvar_a", kind: "document", mimeType: "application/pdf", position: 5 }),
      file({ id: "pf_img1", position: 1 }),
      file({ id: "pf_doc_a1", variantId: "pvar_a", kind: "document", mimeType: "application/pdf", position: 3 }),
      file({ id: "pf_doc_off", variantId: "pvar_off", kind: "document", mimeType: "application/pdf" }),
      file({ id: "pf_doc_shared", kind: "document", mimeType: "application/pdf", position: 9 }),
    ],
  });
  const ids = (fs: CatalogFileDto[]) => fs.map((f) => f.id);

  it("images: solo imágenes compartidas, por position", () => {
    expect(ids(filesForAttach(p, "images"))).toEqual(["pf_img1", "pf_img2"]);
  });

  it("documents: compartidos primero, luego por variante activa y position", () => {
    expect(ids(filesForAttach(p, "documents"))).toEqual([
      "pf_doc_shared",
      "pf_doc_a1",
      "pf_doc_a2",
      "pf_doc_b",
    ]);
  });

  it("all: excluye los de variantes inactivas", () => {
    expect(ids(filesForAttach(p, "all"))).toEqual([
      "pf_img1",
      "pf_img2",
      "pf_doc_shared",
      "pf_doc_a1",
      "pf_doc_a2",
      "pf_doc_b",
    ]);
  });

  it("filesForVariant: compartidos + los de esa variante", () => {
    expect(ids(filesForVariant(p, "pvar_b"))).toEqual(["pf_img1", "pf_img2", "pf_doc_shared", "pf_doc_b"]);
    expect(ids(filesForVariant(p, null))).toEqual(["pf_img1", "pf_img2", "pf_doc_shared"]);
  });

  it("no muta el producto", () => {
    const before = ids(p.files);
    filesForAttach(p, "all");
    filesForVariant(p, "pvar_a");
    expect(ids(p.files)).toEqual(before);
  });
});

describe("defaultShortcutsFor", () => {
  it("fotos_/ficha_ en minúsculas con {{producto}}", () => {
    expect(defaultShortcutsFor({ name: "Tiguan", code: "T03" })).toEqual([
      {
        shortcut: "fotos_t03",
        title: "Fotos Tiguan",
        attach: "images",
        body: "Te comparto las fotos de {{producto}}",
      },
      {
        shortcut: "ficha_t03",
        title: "Ficha técnica Tiguan",
        attach: "documents",
        body: "Te comparto la ficha técnica de {{producto}}",
      },
    ]);
  });

  it("sin código → null", () => {
    expect(defaultShortcutsFor({ name: "X", code: null })).toBeNull();
    expect(defaultShortcutsFor({ name: "X", code: "" })).toBeNull();
  });

  it("código que no cabe en un atajo de 32 → null; el límite exacto sí cabe", () => {
    const max = "A".repeat(SHORTCUT_CODE_MAX);
    const r = defaultShortcutsFor({ name: "X", code: max });
    expect(r).not.toBeNull();
    for (const s of r!) expect(s.shortcut).toMatch(QUICK_REPLY_LIMITS.shortcutPattern);
    expect(defaultShortcutsFor({ name: "X", code: max + "B" })).toBeNull();
  });

  it("recorta el título al tope de las respuestas rápidas", () => {
    const r = defaultShortcutsFor({ name: "N".repeat(120), code: "t1" })!;
    for (const s of r) expect(s.title.length).toBeLessThanOrEqual(QUICK_REPLY_LIMITS.titleMax);
  });
});

describe("fileCompatibility", () => {
  const pdf = { mimeType: "application/pdf", size: 2 * MB };
  const xlsx = { mimeType: OOXML_MIME.xlsx, size: 1 * MB };
  const bigJpg = { mimeType: "image/jpeg", size: 6 * MB };

  it("WhatsApp: PDF y xlsx pasan; imagen > 5 MB no", () => {
    expect(fileCompatibility(pdf, WHATSAPP_OUTBOUND_FILES)).toEqual({ ok: true });
    expect(fileCompatibility(xlsx, WHATSAPP_OUTBOUND_FILES)).toEqual({ ok: true });
    const r = fileCompatibility(bigJpg, WHATSAPP_OUTBOUND_FILES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("5 MB");
  });

  it("Instagram: xlsx no, con la frase del canal; la misma imagen sí cabe (8 MB)", () => {
    expect(fileCompatibility(xlsx, INSTAGRAM_OUTBOUND_FILES)).toEqual({
      ok: false,
      reason: INSTAGRAM_OUTBOUND_FILES.hint,
    });
    expect(INSTAGRAM_OUTBOUND_FILES.hint).toMatch(/Instagram solo acepta/);
    expect(fileCompatibility(bigJpg, INSTAGRAM_OUTBOUND_FILES)).toEqual({ ok: true });
    expect(fileCompatibility(pdf, MESSENGER_OUTBOUND_FILES)).toEqual({ ok: true });
  });

  it("canal sin archivos → razón legible", () => {
    const r = fileCompatibility(pdf, null);
    expect(r.ok).toBe(false);
  });
});

describe("productDetailsText", () => {
  const p = product({ attributes: [{ label: "Motor", value: "eléctrico" }] });

  it("sin variante: nombre · precio + atributos", () => {
    expect(productDetailsText(p)).toBe("Tiguan · desde $589,900\nMotor: eléctrico");
  });

  it("con variante: su precio y sus atributos después de los del producto", () => {
    const v = variant({
      id: "pvar_400",
      name: "400 km",
      price: "$629,900",
      attributes: [{ label: "Autonomía", value: "400 km" }],
    });
    expect(productDetailsText(p, v)).toBe(
      "Tiguan · 400 km · $629,900\nMotor: eléctrico\nAutonomía: 400 km"
    );
  });

  it("variante sin precio hereda el del producto; sin precio alguno se omite", () => {
    expect(productDetailsText(p, variant({ id: "v", name: "300 km" }))).toBe(
      "Tiguan · 300 km · desde $589,900\nMotor: eléctrico"
    );
    expect(productDetailsText(product({ price: null }))).toBe("Tiguan");
  });
});

describe("esquemas Zod", () => {
  it("producto: \"\" borra (null), código conserva mayúsculas, valida patrón", () => {
    const r = productCreateSchema.parse({ name: " Tiguan ", code: "T03", price: "", description: "  " });
    expect(r).toMatchObject({ name: "Tiguan", code: "T03", price: null, description: null });
    expect(productCreateSchema.safeParse({ name: "X", code: "T 03" }).success).toBe(false);
    expect(productCreateSchema.safeParse({ name: "X", code: "a".repeat(33) }).success).toBe(false);
    expect(productCreateSchema.parse({ name: "X", code: "" }).code).toBeNull();
    expect(productCreateSchema.parse({ name: "X" }).code).toBeUndefined();
  });

  it("producto: topes de atributos y precio", () => {
    const attr = { label: "a", value: "b" };
    expect(
      productCreateSchema.safeParse({ name: "X", attributes: Array(CATALOG_LIMITS.attributesMax).fill(attr) }).success
    ).toBe(true);
    expect(
      productCreateSchema.safeParse({ name: "X", attributes: Array(CATALOG_LIMITS.attributesMax + 1).fill(attr) }).success
    ).toBe(false);
    expect(productCreateSchema.safeParse({ name: "X", attributes: [{ label: "x".repeat(41), value: "v" }] }).success).toBe(false);
    expect(productCreateSchema.safeParse({ name: "X", price: "x".repeat(61) }).success).toBe(false);
  });

  it("patch: al menos un campo; categoryId null = sin categoría", () => {
    expect(productPatchSchema.safeParse({}).success).toBe(false);
    expect(productPatchSchema.parse({ categoryId: null })).toEqual({ categoryId: null });
    expect(categoryPatchSchema.safeParse({}).success).toBe(false);
  });

  it("variante: nombre 1-80", () => {
    expect(variantCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(variantCreateSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(variantCreateSchema.parse({ name: "400 km", code: "T03-400" }).code).toBe("T03-400");
  });

  it("lote: 1..10 archivos; texto vacío → sin texto", () => {
    expect(catalogBatchSchema.safeParse({ fileIds: [] }).success).toBe(false);
    expect(catalogBatchSchema.safeParse({ fileIds: Array(11).fill("pf_x") }).success).toBe(false);
    expect(catalogBatchSchema.parse({ text: "  ", fileIds: ["pf_1"] })).toEqual({ fileIds: ["pf_1"] });
    expect(catalogBatchSchema.parse({ text: " hola ", fileIds: ["pf_1"] }).text).toBe("hola");
    expect(catalogBatchSchema.safeParse({ text: "x".repeat(4097), fileIds: ["pf_1"] }).success).toBe(false);
  });
});
