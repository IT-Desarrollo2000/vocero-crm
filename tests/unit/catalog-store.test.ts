import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 019 — Store del catálogo (FR-904/905/908): alta de archivo por FIRMA, orden
 * put → insert, limpieza del blob si el insert falla, 503 sin nada en BD si
 * el storage cae, y la traducción del 23505 de los índices de código.
 * BD simulada: cada `select` consume `selectQueue`; el storage es un doble.
 */

let selectQueue: unknown[][] = [];
const inserts: { table: string; values: Record<string, unknown> }[] = [];
let insertError: Error | null = null;

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) c[m] = () => c;
  (c as { then: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

const db = {
  select: () => chain(selectQueue.shift() ?? []),
  insert: (table: { __name: string }) => ({
    values: (values: Record<string, unknown>) => ({
      returning: () => {
        if (insertError) return Promise.reject(insertError);
        inserts.push({ table: table.__name, values });
        return Promise.resolve([
          { position: 0, createdAt: new Date(), updatedAt: new Date(), ...values },
        ]);
      },
    }),
  }),
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({ ...db, transaction: (fn: (tx: typeof db) => unknown) => fn(db) }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__name" ? String(tableName) : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  // Las columnas simuladas son strings: las condiciones no se evalúan.
  return {
    ...real,
    eq: () => undefined,
    ne: () => undefined,
    inArray: () => undefined,
    count: () => "count",
    sql: Object.assign(() => "sql", { raw: () => "sql" }),
  };
});

vi.mock("@/lib/db/tenant", () => ({ scoped: () => "scoped" }));

const storage = {
  provider: "local" as const,
  put: vi.fn(async (_key: string, _data: Buffer, _mime: string) => {}),
  get: vi.fn(async (_key: string) => Buffer.alloc(0)),
  delete: vi.fn(async (_key: string) => {}),
  test: vi.fn(async () => {}),
};

vi.mock("@/server/catalog/storage", async (orig) => {
  const real = await orig<typeof import("@/server/catalog/storage")>();
  return { ...real, getCatalogStorage: () => storage };
});

import { StorageError } from "@/server/catalog/storage";
import { addProductFile, CatalogError, cleanFileName, isDuplicateCode } from "@/server/catalog/store";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082",
  "hex"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");

const ORG = "org_1";

/** Producto existe y lleva `n` archivos. */
function productWith(n: number) {
  selectQueue.push([{ id: "prd_1" }], [{ n }]);
}

async function rejection(p: Promise<unknown>): Promise<CatalogError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CatalogError);
  return err as CatalogError;
}

beforeEach(() => {
  selectQueue = [];
  inserts.length = 0;
  insertError = null;
  storage.put.mockReset().mockResolvedValue(undefined);
  storage.delete.mockReset().mockResolvedValue(undefined);
});

describe("addProductFile", () => {
  it("PNG → image: put con clave de la org y luego insert con proveedor y clave", async () => {
    productWith(0);
    const dto = await addProductFile(ORG, "prd_1", {
      data: PNG,
      fileName: "frente.png",
      declaredMime: "image/png",
    });
    expect(dto.kind).toBe("image");
    expect(dto.mimeType).toBe("image/png");
    expect(dto.url).toBe(`/api/catalog/files/${dto.id}`);
    expect(storage.put).toHaveBeenCalledWith(`${ORG}/catalog/${dto.id}`, PNG, "image/png");
    expect(inserts[0]?.values).toMatchObject({
      storageProvider: "local",
      storageKey: `${ORG}/catalog/${dto.id}`,
      variantId: null,
      fileSize: PNG.byteLength,
    });
  });

  it("PDF → document; el nombre se limpia de rutas", async () => {
    productWith(1);
    const dto = await addProductFile(ORG, "prd_1", { data: PDF, fileName: "C:\\x\\ficha.pdf" });
    expect(dto.kind).toBe("document");
    expect(dto.fileName).toBe("ficha.pdf");
  });

  it(".exe renombrado a .pdf → 415 con razón; nada en storage ni BD", async () => {
    productWith(0);
    const err = await rejection(
      addProductFile(ORG, "prd_1", { data: EXE, fileName: "ficha.pdf", declaredMime: "application/pdf" })
    );
    expect(err.status).toBe(415);
    expect(err.code).toBe("unsupported_type");
    expect(err.message).toMatch(/ejecutable/);
    expect(storage.put).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("GIF (pasa la política de 018 pero no es del catálogo) → 415 legible", async () => {
    productWith(0);
    const err = await rejection(addProductFile(ORG, "prd_1", { data: GIF, fileName: "a.gif" }));
    expect(err.status).toBe(415);
    expect(err.message).toMatch(/JPG o PNG/);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("tope de 20 → 409 too_many_files antes de tocar el storage", async () => {
    productWith(20);
    const err = await rejection(addProductFile(ORG, "prd_1", { data: PNG, fileName: "a.png" }));
    expect([err.status, err.code]).toEqual([409, "too_many_files"]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("producto ajeno → 404; variante de otro producto → 422", async () => {
    selectQueue.push([]);
    expect((await rejection(addProductFile(ORG, "prd_x", { data: PNG, fileName: "a.png" }))).status).toBe(404);
    selectQueue.push([{ id: "prd_1" }], []);
    const err = await rejection(
      addProductFile(ORG, "prd_1", { data: PNG, fileName: "a.png", variantId: "pvar_otro" })
    );
    expect([err.status, err.code]).toEqual([422, "invalid_variant"]);
  });

  it("storage caído → 503 storage_unavailable y nada en BD", async () => {
    productWith(0);
    storage.put.mockRejectedValueOnce(new StorageError("unavailable", "No se pudo guardar"));
    const err = await rejection(addProductFile(ORG, "prd_1", { data: PNG, fileName: "a.png" }));
    expect([err.status, err.code]).toEqual([503, "storage_unavailable"]);
    expect(inserts).toEqual([]);
  });

  it("si el insert falla, borra el blob recién escrito", async () => {
    productWith(0);
    insertError = new Error("db caída");
    await expect(addProductFile(ORG, "prd_1", { data: PNG, fileName: "a.png" })).rejects.toThrow(
      "db caída"
    );
    const key = storage.put.mock.calls[0]?.[0];
    expect(storage.delete).toHaveBeenCalledWith(key);
  });
});

describe("isDuplicateCode / cleanFileName", () => {
  it("23505 de cualquiera de los dos índices de código (directo o en cause)", () => {
    expect(isDuplicateCode({ code: "23505", constraint_name: "product_org_code_uq" })).toBe(true);
    expect(
      isDuplicateCode({ cause: { code: "23505", constraint_name: "product_variant_org_code_uq" } })
    ).toBe(true);
    expect(isDuplicateCode({ code: "23505", constraint_name: "product_pkey" })).toBe(false);
    expect(isDuplicateCode(new Error("x"))).toBe(false);
  });

  it("nombre vacío → archivo.<ext>; sin control ni rutas", () => {
    expect(cleanFileName("", "pdf")).toBe("archivo.pdf");
    expect(cleanFileName("../../a\u0000b.png", "png")).toBe("ab.png");
  });
});
