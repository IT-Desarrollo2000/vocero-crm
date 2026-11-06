import { describe, expect, it } from "vitest";
import type { CatalogFileDto, CatalogProductDto, CatalogVariantDto } from "@/lib/catalog";
import {
  PAUSED_LABEL,
  READY_LABEL,
  catalogSummary,
  defaultShortcutStates,
  filesSummary,
  joinY,
  pausedExplanation,
  productReadiness,
  type ShortcutRef,
} from "@/lib/catalog-readiness";

/** 032 — «Listo para mandar / Le falta: … / Pausado» del Catálogo. */

function file(over: Partial<CatalogFileDto> & { id: string }): CatalogFileDto {
  return {
    productId: "pr_1",
    variantId: null,
    kind: "image",
    mimeType: "image/jpeg",
    fileName: `${over.id}.jpg`,
    size: 100,
    position: 0,
    url: `/api/catalog/files/${over.id}`,
    ...over,
  };
}

function variant(over: Partial<CatalogVariantDto> & { id: string }): CatalogVariantDto {
  return {
    productId: "pr_1",
    name: over.id,
    code: null,
    price: null,
    attributes: [],
    active: true,
    position: 0,
    ...over,
  };
}

function product(over: Partial<CatalogProductDto> = {}): CatalogProductDto {
  return {
    id: "pr_1",
    categoryId: null,
    name: "Comedor Nogal",
    code: "COM-006",
    price: "$24,500",
    description: null,
    attributes: [],
    active: true,
    position: 0,
    variants: [],
    files: [
      file({ id: "f1" }),
      file({ id: "f2", position: 1 }),
      file({ id: "d1", kind: "document", mimeType: "application/pdf", fileName: "ficha.pdf" }),
    ],
    ...over,
  };
}

const linked: ShortcutRef[] = [
  { shortcut: "fotos_com-006", productId: "pr_1", attach: "images" },
  { shortcut: "ficha_com-006", productId: "pr_1", attach: "documents" },
];

describe("productReadiness", () => {
  it("fotos + ficha + precio + atajos + activo → Listo para mandar", () => {
    const r = productReadiness(product(), linked);
    expect(r.state).toBe("ready");
    expect(r.tone).toBe("success");
    expect(r.label).toBe(READY_LABEL);
    expect(r.missing).toEqual([]);
    expect(r.images).toBe(2);
    expect(r.documents).toBe(1);
    expect(r.shortcuts).toEqual([
      { shortcut: "fotos_com-006", attach: "images", sends: "las 2 fotos" },
      { shortcut: "ficha_com-006", attach: "documents", sends: "la ficha" },
    ]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.text)).toEqual([
      "2 fotos",
      "Precio: $24,500",
      "Visible en el chat (está activo)",
      "Atajos: /fotos_com-006, /ficha_com-006",
      "1 ficha",
    ]);
  });

  it("sin ficha → Le falta: ficha PDF (aviso, no peligro)", () => {
    const r = productReadiness(product({ files: [file({ id: "f1" })] }), linked);
    expect(r.state).toBe("missing");
    expect(r.tone).toBe("warning");
    expect(r.label).toBe("Le falta: ficha PDF");
    expect(r.checks.find((c) => c.id === "ficha")).toEqual({
      id: "ficha",
      ok: false,
      text: "Sin ficha PDF: el cliente solo recibe las fotos.",
    });
    expect(r.shortcuts?.[1]?.sends).toBe("solo el texto (aún no tiene ficha)");
  });

  it("sin fotos → Le faltan las fotos (peligro)", () => {
    const r = productReadiness(
      product({ files: [file({ id: "d1", kind: "document", mimeType: "application/pdf" })] }),
      linked
    );
    expect(r.label).toBe("Le faltan las fotos");
    expect(r.tone).toBe("danger");
    expect(r.checks[0]?.text).toBe("Sin fotos: el cliente solo recibe la ficha.");
  });

  it("sin código ni atajos → Le falta: código", () => {
    const r = productReadiness(product({ code: null }), []);
    expect(r.missing).toEqual(["codigo"]);
    expect(r.label).toBe("Le falta: código");
    expect(r.checks.find((c) => c.id === "atajos")?.text).toMatch(/^Sin código/);
  });

  it("con código pero sin atajos → Le falta: atajos", () => {
    const r = productReadiness(product(), []);
    expect(r.label).toBe("Le falta: atajos");
    expect(r.checks.find((c) => c.id === "atajos")?.text).toBe(
      "Sin atajos todavía."
    );
  });

  it("código más largo que el atajo → Le falta: código más corto", () => {
    const r = productReadiness(product({ code: "A".repeat(27) }), []);
    expect(r.missing).toEqual(["codigo_largo"]);
  });

  it("un atajo hecho a mano (sin código) basta", () => {
    const r = productReadiness(product({ code: null }), [
      { shortcut: "nogal", productId: "pr_1", attach: "all" },
    ]);
    expect(r.state).toBe("ready");
    expect(r.shortcuts?.[0]?.sends).toBe("los 3 archivos");
  });

  it("atajos ilegibles (null) → no acusa falta de atajos ni muestra su punto", () => {
    const r = productReadiness(product({ code: null }), null);
    expect(r.state).toBe("ready");
    expect(r.shortcuts).toBeNull();
    expect(r.checks.some((c) => c.id === "atajos")).toBe(false);
  });

  it("atajos de OTRO producto no cuentan", () => {
    const r = productReadiness(product(), [
      { shortcut: "fotos_com-006", productId: "pr_9", attach: "images" },
    ]);
    expect(r.missing).toEqual(["atajos"]);
  });

  it("varios faltantes en orden: fotos, precio, código, ficha", () => {
    const r = productReadiness(product({ files: [], price: null, code: null }), []);
    expect(r.missing).toEqual(["fotos", "precio", "codigo", "ficha"]);
    expect(r.label).toBe("Le falta: fotos, precio, código y ficha PDF");
    expect(r.checks[0]?.text).toBe("Sin fotos ni ficha: no hay nada que mandarle al cliente.");
  });

  it("precio de variante activa cubre el precio", () => {
    const r = productReadiness(
      product({ price: null, variants: [variant({ id: "pv_a", price: "$1" })] }),
      linked
    );
    expect(r.missing).toEqual([]);
    expect(r.checks.find((c) => c.id === "precio")?.text).toBe("Precio: según la variante");
  });

  it("archivos de una variante PAUSADA no cuentan (no salen por el atajo)", () => {
    const r = productReadiness(
      product({
        variants: [variant({ id: "pv_off", active: false })],
        files: [
          file({ id: "f1", variantId: "pv_off" }),
          file({ id: "d1", kind: "document", mimeType: "application/pdf" }),
        ],
      }),
      linked
    );
    expect(r.images).toBe(0);
    expect(r.label).toBe("Le faltan las fotos");
  });

  it("pausado gana a todo y conserva los faltantes", () => {
    const r = productReadiness(product({ active: false, files: [] }), linked);
    expect(r.state).toBe("paused");
    expect(r.tone).toBe("muted");
    expect(r.label).toBe(PAUSED_LABEL);
    expect(r.missing).toContain("fotos");
    expect(r.checks.find((c) => c.id === "activo")?.ok).toBe(false);
  });
});

describe("pausedExplanation", () => {
  it("dice por qué, según quién mira", () => {
    expect(pausedExplanation(false)).toMatch(/^El propietario lo pausó/);
    expect(pausedExplanation(true)).toMatch(/actívalo en «Editar»/);
  });
});

describe("catalogSummary", () => {
  const item = (name: string, p: CatalogProductDto, s: ShortcutRef[] | null = linked) => ({
    product: { name },
    readiness: productReadiness(p, s),
  });

  it("cuenta listos, incompletos, solo-ficha y pausados", () => {
    const s = catalogSummary([
      item("Sala Lisboa", product()),
      item("Comedor Nogal", product({ files: [file({ id: "f1" })] })),
      item("Comedor Roble", product({ files: [file({ id: "d", kind: "document", mimeType: "application/pdf" })] })),
      item("Mesa de centro", product({ code: null }), []),
      item("Pausado", product({ active: false })),
    ]);
    expect(s).toMatchObject({
      active: 4,
      ready: 1,
      withMissing: 3,
      incomplete: 2,
      onlyFicha: 1,
      paused: 1,
      headline: "2 productos no se pueden mandar completos todavía",
      more: 0,
    });
    expect(s.details).toEqual([
      "Comedor Roble no tiene fotos",
      "Mesa de centro no tiene código, así que no tiene atajo para escribirlo en el chat",
    ]);
    expect(s.fichaNote).toBe(
      "A 1 producto solo le falta la ficha PDF: el cliente recibe las fotos."
    );
  });

  it("todo listo → sin titular; recorta el detalle con «más»", () => {
    expect(catalogSummary([item("A", product())]).headline).toBeNull();
    const many = ["A", "B", "C", "D", "E"].map((n) => item(n, product({ files: [] })));
    const s = catalogSummary(many, 3);
    expect(s.headline).toBe("5 productos no se pueden mandar completos todavía");
    expect(s.details).toHaveLength(3);
    expect(s.more).toBe(2);
    expect(s.details[0]).toBe("A no tiene fotos");
  });
});

describe("defaultShortcutStates", () => {
  it("ligado, ocupado por otra respuesta o por crear", () => {
    const st = defaultShortcutStates(product(), [
      { shortcut: "fotos_com-006", productId: "pr_1", attach: "images" },
      { shortcut: "ficha_com-006", productId: null, attach: null },
    ]);
    expect(st?.map((s) => [s.shortcut, s.status, s.text])).toEqual([
      ["fotos_com-006", "linked", "Ya existe"],
      ["ficha_com-006", "taken", "Ese atajo ya lo usa otra respuesta rápida"],
    ]);
    expect(defaultShortcutStates(product(), [])?.every((s) => s.status === "missing")).toBe(true);
  });

  it("null sin código o sin lista", () => {
    expect(defaultShortcutStates(product({ code: null }), [])).toBeNull();
    expect(defaultShortcutStates(product(), null)).toBeNull();
  });
});

describe("joinY", () => {
  it("une en español", () => {
    expect(joinY([])).toBe("");
    expect(joinY(["a"])).toBe("a");
    expect(joinY(["a", "b"])).toBe("a y b");
    expect(joinY(["a", "b", "c"])).toBe("a, b y c");
  });
});

describe("filesSummary", () => {
  it("cuenta fotos y fichas en palabras", () => {
    expect(filesSummary(2, 1)).toBe("2 fotos y 1 ficha");
    expect(filesSummary(1, 0)).toBe("1 foto");
    expect(filesSummary(0, 2)).toBe("2 fichas");
    expect(filesSummary(0, 0)).toBeNull();
  });
});
