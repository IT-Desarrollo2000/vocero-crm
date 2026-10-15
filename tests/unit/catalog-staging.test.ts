import { describe, expect, it } from "vitest";
import {
  catalogBatchBody,
  filterCatalogProducts,
  panelFiles,
  productCover,
  quickReplyFiles,
  splitStaged,
  stageFiles,
  stagedAfterSend,
  summarizeBatch,
  visibleQuickReplies,
} from "@/components/inbox/catalog-staging";
import type { CatalogFileDto, CatalogProductDto } from "@/lib/catalog";
import {
  INSTAGRAM_OUTBOUND_FILES,
  WHATSAPP_OUTBOUND_FILES,
} from "@/lib/outbound-files";
import type { QuickReplyProductDto } from "@/lib/types";

/** 019 — Escenificación del compositor (FR-930..933), lógica pura. */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function file(id: string, over: Partial<CatalogFileDto> = {}): CatalogFileDto {
  return {
    id,
    productId: "pr_1",
    variantId: null,
    kind: "image",
    mimeType: "image/jpeg",
    fileName: `${id}.jpg`,
    size: 1000,
    position: 0,
    url: `/api/catalog/files/${id}`,
    ...over,
  };
}

const xlsx = (id: string) =>
  file(id, { kind: "document", mimeType: XLSX, fileName: `${id}.xlsx` });

function product(over: Partial<QuickReplyProductDto> = {}): QuickReplyProductDto {
  return { id: "pr_1", name: "Tiguan", code: "T03", active: true, files: [], ...over };
}

describe("visibleQuickReplies", () => {
  it("oculta producto inactivo y las ligadas sin texto ni archivos", () => {
    const list = [
      { id: "a", body: "Hola", product: null },
      { id: "b", body: "Fotos", product: product({ active: false, files: [file("f1")] }) },
      { id: "c", body: "", product: product() },
      { id: "d", body: "  ", product: null },
      { id: "e", body: "", product: product({ files: [file("f1")] }) },
    ];
    expect(visibleQuickReplies(list).map((r) => r.id)).toEqual(["a", "e"]);
  });

  it("quickReplyFiles: nada si no hay producto o está inactivo", () => {
    expect(quickReplyFiles({ product: null })).toEqual([]);
    expect(quickReplyFiles({ product: product({ active: false, files: [file("f1")] }) })).toEqual([]);
    expect(quickReplyFiles({ product: product({ files: [file("f1")] }) })).toHaveLength(1);
  });
});

describe("stageFiles", () => {
  it("acumula sin duplicar por id, conservando el orden", () => {
    const first = stageFiles([], [file("a"), file("b")], WHATSAPP_OUTBOUND_FILES);
    const second = stageFiles(first.staged, [file("b"), file("c")], WHATSAPP_OUTBOUND_FILES);
    expect(second.staged.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(second.added).toBe(1);
    expect(second.overLimit).toBe(0);
  });

  it("el tope cuenta solo los compatibles; el excedente no se agrega", () => {
    const current = [file("a"), file("b"), xlsx("x1")];
    const r = stageFiles(
      current,
      [xlsx("x2"), file("c"), file("d")],
      INSTAGRAM_OUTBOUND_FILES,
      3
    );
    expect(r.staged.map((f) => f.id)).toEqual(["a", "b", "x1", "x2", "c"]);
    expect(r.added).toBe(2);
    expect(r.overLimit).toBe(1);
  });
});

describe("splitStaged y catalogBatchBody", () => {
  it("separa incompatibles con su razón", () => {
    const s = splitStaged([file("a"), xlsx("x")], INSTAGRAM_OUTBOUND_FILES);
    expect(s.sendable.map((f) => f.id)).toEqual(["a"]);
    expect(s.blocked).toHaveLength(1);
    expect(s.blocked[0]!.file.id).toBe("x");
    expect(s.blocked[0]!.reason).toBe(INSTAGRAM_OUTBOUND_FILES.hint);
  });

  it("sin canal de archivos, todo queda bloqueado", () => {
    expect(splitStaged([file("a")], null).sendable).toEqual([]);
  });

  it("arma el body con texto recortado y solo ids compatibles en orden", () => {
    expect(
      catalogBatchBody("  Te comparto  ", [file("b"), xlsx("x"), file("a")], INSTAGRAM_OUTBOUND_FILES)
    ).toEqual({ text: "Te comparto", fileIds: ["b", "a"] });
    expect(catalogBatchBody("   ", [file("a")], WHATSAPP_OUTBOUND_FILES)).toEqual({
      fileIds: ["a"],
    });
  });

  it("null si no hay enviables", () => {
    expect(catalogBatchBody("hola", [xlsx("x")], INSTAGRAM_OUTBOUND_FILES)).toBeNull();
    expect(catalogBatchBody("hola", [], WHATSAPP_OUTBOUND_FILES)).toBeNull();
  });
});

describe("stagedAfterSend", () => {
  it("conserva solo los failed", () => {
    const staged = [file("a"), file("b"), file("c"), xlsx("x")];
    const left = stagedAfterSend(staged, {
      results: [
        { fileId: "a", status: "sent", messageId: "m1" },
        { fileId: "b", status: "failed", reason: "file_missing" },
        { fileId: "c", status: "skipped", reason: "Muy grande" },
      ],
    });
    expect(left.map((f) => f.id)).toEqual(["b"]);
  });
});

describe("summarizeBatch", () => {
  const staged = [file("a"), file("b"), file("c"), xlsx("x")];

  it("todo enviado", () => {
    expect(
      summarizeBatch(
        { results: [{ fileId: "a", status: "sent" }, { fileId: "b", status: "sent" }] },
        staged,
        0
      )
    ).toBe("2 de 2 enviados");
  });

  it("cuenta incompatibles y lista razones de skipped/failed", () => {
    expect(
      summarizeBatch(
        {
          text: { messageId: "m0" },
          results: [
            { fileId: "a", status: "sent" },
            { fileId: "b", status: "skipped", reason: "Supera el límite" },
            { fileId: "c", status: "failed", reason: "file_missing" },
          ],
        },
        staged,
        1
      )
    ).toBe(
      "1 de 4 enviados · 1 no es compatible con este canal · b.jpg: Supera el límite · c.jpg: el archivo no está en el almacenamiento"
    );
  });

  it("lote detenido: no lista los 'stopped' uno por uno", () => {
    expect(
      summarizeBatch(
        {
          results: [
            { fileId: "a", status: "sent" },
            { fileId: "b", status: "failed", reason: "window_closed" },
            { fileId: "c", status: "failed", reason: "stopped" },
          ],
          stopped: "window_closed",
        },
        staged,
        2
      )
    ).toBe(
      "1 de 5 enviados · 2 no son compatibles con este canal · Se detuvo: la ventana de conversación está cerrada"
    );
  });
});

describe("panel Catálogo", () => {
  const p: CatalogProductDto = {
    id: "pr_1",
    categoryId: "cat_suv",
    name: "Tiguán",
    code: "T03",
    price: "$1",
    description: null,
    attributes: [],
    active: true,
    position: 0,
    variants: [
      { id: "v400", productId: "pr_1", name: "400 km", code: null, price: null, attributes: [], active: true, position: 0 },
      { id: "v300", productId: "pr_1", name: "300 km", code: null, price: null, attributes: [], active: true, position: 1 },
      { id: "vold", productId: "pr_1", name: "viejo", code: null, price: null, attributes: [], active: false, position: 2 },
    ],
    files: [
      file("doc400", { variantId: "v400", kind: "document", mimeType: "application/pdf", fileName: "400.pdf" }),
      file("foto1", { position: 1 }),
      file("foto0", { position: 0 }),
      file("doc300", { variantId: "v300", kind: "document", mimeType: "application/pdf", fileName: "300.pdf" }),
      file("docold", { variantId: "vold", kind: "document", mimeType: "application/pdf" }),
    ],
  };

  it("variante: compartidos + los de esa variante", () => {
    expect(panelFiles(p, "v400").map((f) => f.id)).toEqual(["foto0", "foto1", "doc400"]);
  });

  it("Todas: compartidos + de variantes activas", () => {
    expect(panelFiles(p, null).map((f) => f.id)).toEqual([
      "foto0",
      "foto1",
      "doc400",
      "doc300",
    ]);
  });

  it("filtra activos por categoría y por nombre/código sin acentos", () => {
    const inactive = { ...p, id: "pr_2", active: false };
    const other = { ...p, id: "pr_3", name: "Jetta", code: "J1", categoryId: "cat_sedan" };
    const all = [p, inactive, other];
    expect(filterCatalogProducts(all, "", null).map((x) => x.id)).toEqual(["pr_1", "pr_3"]);
    expect(filterCatalogProducts(all, "tiguan", null).map((x) => x.id)).toEqual(["pr_1"]);
    expect(filterCatalogProducts(all, "j1", null).map((x) => x.id)).toEqual(["pr_3"]);
    expect(filterCatalogProducts(all, "", "cat_suv").map((x) => x.id)).toEqual(["pr_1"]);
  });

  it("portada = primera imagen", () => {
    expect(productCover(p)?.id).toBe("foto0");
    expect(productCover({ ...p, files: [] })).toBeNull();
  });
});
