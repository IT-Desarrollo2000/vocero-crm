import { describe, expect, it } from "vitest";
import type { CatalogFileDto, CatalogProductDto } from "@/lib/catalog";
import {
  catalogErrorText,
  cleanAttributes,
  coverImage,
  filterProducts,
  groupFiles,
  shortcutOutcome,
  swapPositions,
  variantPrice,
} from "@/components/catalog/catalog-view";

/** 019 — lógica pura de la página Catálogo (A3). */

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

function product(over: Partial<CatalogProductDto> & { id: string }): CatalogProductDto {
  return {
    categoryId: null,
    name: "Producto",
    code: null,
    price: null,
    description: null,
    attributes: [],
    active: true,
    position: 0,
    variants: [],
    files: [],
    ...over,
  };
}

const tiguan = product({
  id: "pr_1",
  name: "Tiguán",
  code: "T03",
  categoryId: "cat_suv",
  price: "desde $589,900",
  variants: [
    {
      id: "pv_400",
      productId: "pr_1",
      name: "400 km",
      code: "T03-400",
      price: "$629,900",
      attributes: [],
      active: true,
      position: 0,
    },
    {
      id: "pv_300",
      productId: "pr_1",
      name: "300 km",
      code: null,
      price: null,
      attributes: [],
      active: true,
      position: 1,
    },
  ],
});
const sedan = product({ id: "pr_2", name: "Jetta", code: "J01", categoryId: "cat_sedan" });
const loose = product({ id: "pr_3", name: "Llavero" });

describe("filterProducts", () => {
  const all = [tiguan, sedan, loose];

  it("sin filtros devuelve todo", () => {
    expect(filterProducts(all, "", "all")).toHaveLength(3);
  });

  it("busca por nombre sin mayúsculas ni acentos", () => {
    expect(filterProducts(all, "tiguan", "all").map((p) => p.id)).toEqual(["pr_1"]);
  });

  it("busca por código de producto y de variante", () => {
    expect(filterProducts(all, "j01", "all").map((p) => p.id)).toEqual(["pr_2"]);
    expect(filterProducts(all, "t03-400", "all").map((p) => p.id)).toEqual(["pr_1"]);
  });

  it("filtra por categoría y por 'sin categoría'", () => {
    expect(filterProducts(all, "", "cat_suv").map((p) => p.id)).toEqual(["pr_1"]);
    expect(filterProducts(all, "", "none").map((p) => p.id)).toEqual(["pr_3"]);
    expect(filterProducts(all, "jetta", "cat_suv")).toEqual([]);
  });
});

describe("coverImage", () => {
  it("prefiere la primera imagen compartida por posición", () => {
    const p = product({
      id: "x",
      files: [
        file({ id: "f_var", variantId: "pv", position: 0 }),
        file({ id: "f_b", position: 2 }),
        file({ id: "f_a", position: 1 }),
        file({ id: "f_doc", kind: "document", position: 0 }),
      ],
    });
    expect(coverImage(p)?.id).toBe("f_a");
  });

  it("sin compartidas usa la de una variante; sin imágenes, undefined", () => {
    expect(coverImage(product({ id: "x", files: [file({ id: "v", variantId: "pv" })] }))?.id).toBe(
      "v"
    );
    expect(
      coverImage(product({ id: "x", files: [file({ id: "d", kind: "document" })] }))
    ).toBeUndefined();
  });
});

describe("groupFiles", () => {
  it("Compartidos primero y luego por variante; huérfanos a compartidos", () => {
    const p = {
      ...tiguan,
      files: [
        file({ id: "s2", position: 3 }),
        file({ id: "v400", variantId: "pv_400", position: 1 }),
        file({ id: "s1", position: 0 }),
        file({ id: "orphan", variantId: "pv_gone", position: 5 }),
      ],
    };
    const groups = groupFiles(p);
    expect(groups.map((g) => [g.label, g.files.map((f) => f.id)])).toEqual([
      ["Compartidos", ["s1", "s2", "orphan"]],
      ["400 km", ["v400"]],
      ["300 km", []],
    ]);
  });
});

describe("swapPositions", () => {
  const list = [
    { id: "a", position: 2 },
    { id: "b", position: 5 },
    { id: "c", position: 9 },
  ];

  it("intercambia las posiciones de los dos vecinos", () => {
    expect(swapPositions(list, 1, -1)).toEqual([
      { id: "b", position: 2 },
      { id: "a", position: 5 },
    ]);
    expect(swapPositions(list, 1, 1)).toEqual([
      { id: "c", position: 5 },
      { id: "b", position: 9 },
    ]);
  });

  it("en los extremos no hace nada", () => {
    expect(swapPositions(list, 0, -1)).toEqual([]);
    expect(swapPositions(list, 2, 1)).toEqual([]);
  });

  it("con posiciones repetidas renumera para que el cambio se note", () => {
    const tied = [
      { id: "a", position: 0 },
      { id: "b", position: 0 },
    ];
    expect(swapPositions(tied, 1, -1)).toEqual([{ id: "a", position: 1 }]);
  });
});

describe("cleanAttributes", () => {
  it("recorta, descarta vacías y avisa de filas a medias", () => {
    expect(
      cleanAttributes([
        { label: " Motor ", value: " eléctrico " },
        { label: "", value: "" },
        { label: "Color", value: "" },
      ])
    ).toEqual({ attributes: [{ label: "Motor", value: "eléctrico" }], incomplete: true });
  });
});

describe("variantPrice", () => {
  it("usa el propio o hereda el del producto", () => {
    expect(variantPrice(tiguan, { price: "$1" })).toEqual({ text: "$1", inherited: false });
    expect(variantPrice(tiguan, { price: null })).toEqual({
      text: "desde $589,900",
      inherited: true,
    });
  });
});

describe("catalogErrorText", () => {
  it("prefiere el mensaje del servidor", () => {
    expect(
      catalogErrorText(415, { error: { code: "unsupported_type", message: "Solo JPG" } }, "x")
    ).toBe("Solo JPG");
  });

  it("sin red y sin mensaje", () => {
    expect(catalogErrorText(null, null, "x")).toMatch(/Sin conexión/);
    expect(catalogErrorText(503, null, "x")).toMatch(/almacenamiento/);
    expect(catalogErrorText(500, null, "fallo")).toBe("fallo");
  });
});

describe("shortcutOutcome", () => {
  it("201 creado, 409 duplicate_shortcut ya existía, otro error con mensaje", () => {
    expect(shortcutOutcome("fotos_t03", 201, null).status).toBe("created");
    const dup = shortcutOutcome("fotos_t03", 409, {
      error: { code: "duplicate_shortcut", message: "Ya existe" },
    });
    expect(dup).toMatchObject({ status: "exists" });
    expect(dup.message).toMatch(/ya existía \/fotos_t03/i);
    const bad = shortcutOutcome("ficha_t03", 422, {
      error: { code: "unknown_variable", message: "Variable desconocida: {{producto}}" },
    });
    expect(bad).toMatchObject({ status: "error" });
    expect(bad.message).toContain("{{producto}}");
  });
});
