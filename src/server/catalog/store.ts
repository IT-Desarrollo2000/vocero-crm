import { asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import {
  catalogFileUrl,
  fileKindFor,
  type CatalogCategoryDto,
  type CatalogDto,
  type CatalogFileDto,
  type CatalogProductDto,
  type CatalogVariantDto,
  CATALOG_LIMITS,
  type CategoryCreateBody,
  type CategoryPatchBody,
  type ProductCreateBody,
  type ProductFilePatchBody,
  type ProductPatchBody,
  type VariantCreateBody,
  type VariantPatchBody,
} from "@/lib/catalog";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { inspectOutgoing, MediaValidationError } from "@/server/media/file-policy";
import { CatalogFileError, getCatalogFileRow, readCatalogFileData } from "./files";
import {
  catalogStorageKey,
  getCatalogStorage,
  StorageError,
  type CatalogStorage,
} from "./storage";

/**
 * 019 — Persistencia del catálogo (FR-901..908, FR-912): categorías →
 * productos → variantes → archivos. Toda query pasa por `scoped(…)`.
 *
 * Las rutas validan la FORMA (Zod de `src/lib/catalog.ts`); aquí viven las
 * reglas que necesitan la BD y la traducción de TODO error esperable a
 * `CatalogError` (las rutas no conocen `StorageError` ni
 * `MediaValidationError`):
 *
 *   404 not_found           el recurso no es de la org
 *   409 duplicate_code      código repetido entre productos y variantes
 *   409 too_many_files      ya hay `maxFilesPerProduct` archivos
 *   410 file_missing        la fila existe pero sus bytes no (al servir)
 *   413 too_large           pasa del tope global de 018
 *   415 unsupported_type    la firma no es imagen JPG/PNG ni documento admitido
 *   422 invalid_category    `categoryId` que no es de la org
 *   422 invalid_variant     `variantId` que no es variante de ESE producto
 *   503 storage_unavailable el proveedor no responde o está mal configurado
 *
 * Borrar archivo/variante/producto borra sus bytes donde se guardó cada uno
 * (`storage_provider`), DESPUÉS del DELETE y best-effort: un fallo se
 * registra y no revierte. Los ids reutilizables de Meta
 * (`product_file_upload`) caen solos por `ON DELETE CASCADE` (0021).
 */

export type CatalogErrorCode =
  | "not_found"
  | "duplicate_code"
  | "too_many_files"
  | "file_missing"
  | "too_large"
  | "unsupported_type"
  | "invalid_category"
  | "invalid_variant"
  | "storage_unavailable";

const DEFAULT_MESSAGE: Record<CatalogErrorCode, string> = {
  not_found: "No encontrado",
  duplicate_code: "Ese código ya lo usa otro producto o variante",
  too_many_files: `Un producto admite hasta ${CATALOG_LIMITS.maxFilesPerProduct} archivos`,
  file_missing: "El archivo ya no está en el almacenamiento del catálogo",
  too_large: "El archivo es demasiado grande",
  unsupported_type:
    "El catálogo solo acepta imágenes JPG o PNG y documentos PDF, Word, Excel, PowerPoint, TXT o CSV",
  invalid_category: "La categoría no existe",
  invalid_variant: "La variante no es de este producto",
  storage_unavailable: "El almacenamiento del catálogo no está disponible",
};

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: CatalogErrorCode,
    message?: string
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "CatalogError";
  }
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;

type CategoryRow = typeof schema.productCategory.$inferSelect;
type ProductRow = typeof schema.product.$inferSelect;
type VariantRow = typeof schema.productVariant.$inferSelect;
export type ProductFileRow = typeof schema.productFile.$inferSelect;

/* ------------------------------------------------------------------ *
 * Serialización
 * ------------------------------------------------------------------ */

function serializeCategory(r: CategoryRow): CatalogCategoryDto {
  return { id: r.id, name: r.name, position: r.position };
}

function serializeVariant(r: VariantRow): CatalogVariantDto {
  return {
    id: r.id,
    productId: r.productId,
    name: r.name,
    code: r.code,
    price: r.price,
    attributes: r.attributes,
    active: r.active,
    position: r.position,
  };
}

export function serializeProductFile(r: ProductFileRow): CatalogFileDto {
  return {
    id: r.id,
    productId: r.productId,
    variantId: r.variantId,
    kind: r.kind,
    mimeType: r.mimeType,
    fileName: r.fileName,
    size: r.fileSize,
    position: r.position,
    url: catalogFileUrl(r.id),
  };
}

function serializeProduct(
  r: ProductRow,
  variants: CatalogVariantDto[],
  files: CatalogFileDto[]
): CatalogProductDto {
  return {
    id: r.id,
    categoryId: r.categoryId,
    name: r.name,
    code: r.code,
    price: r.price,
    description: r.description,
    attributes: r.attributes,
    active: r.active,
    position: r.position,
    variants,
    files,
  };
}

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

/**
 * Productos con sus variantes y archivos (por `position`, luego id), en 3
 * consultas sin importar cuántos sean. `productIds` undefined = todos los de
 * la org; [] = ninguno. Lo usa también `GET /api/quick-replies`.
 */
export async function loadProducts(
  organizationId: string,
  productIds?: readonly string[],
  q: Q = getDb()
): Promise<CatalogProductDto[]> {
  if (productIds && productIds.length === 0) return [];
  const p = schema.product;
  const v = schema.productVariant;
  const f = schema.productFile;
  const ids = productIds ? [...new Set(productIds)] : undefined;

  const [products, variants, files] = await Promise.all([
    q
      .select()
      .from(p)
      .where(scoped(p.organizationId, organizationId, ids ? inArray(p.id, ids) : undefined))
      .orderBy(asc(p.position), asc(p.createdAt), asc(p.id)),
    q
      .select()
      .from(v)
      .where(scoped(v.organizationId, organizationId, ids ? inArray(v.productId, ids) : undefined))
      .orderBy(asc(v.position), asc(v.createdAt), asc(v.id)),
    q
      .select()
      .from(f)
      .where(scoped(f.organizationId, organizationId, ids ? inArray(f.productId, ids) : undefined))
      .orderBy(asc(f.position), asc(f.createdAt), asc(f.id)),
  ]);

  const variantsBy = new Map<string, CatalogVariantDto[]>();
  for (const row of variants) {
    const list = variantsBy.get(row.productId) ?? [];
    list.push(serializeVariant(row));
    variantsBy.set(row.productId, list);
  }
  const filesBy = new Map<string, CatalogFileDto[]>();
  for (const row of files) {
    const list = filesBy.get(row.productId) ?? [];
    list.push(serializeProductFile(row));
    filesBy.set(row.productId, list);
  }
  return products.map((row) =>
    serializeProduct(row, variantsBy.get(row.id) ?? [], filesBy.get(row.id) ?? [])
  );
}

/** `GET /api/catalog`. */
export async function getCatalog(organizationId: string): Promise<CatalogDto> {
  const c = schema.productCategory;
  const [categories, products] = await Promise.all([
    getDb()
      .select()
      .from(c)
      .where(scoped(c.organizationId, organizationId))
      .orderBy(asc(c.position), asc(c.createdAt), asc(c.id)),
    loadProducts(organizationId),
  ]);
  return {
    categories: categories.map(serializeCategory),
    products,
    storage: { provider: getCatalogStorage().provider },
  };
}

async function productDto(organizationId: string, id: string, q: Q = getDb()) {
  const [dto] = await loadProducts(organizationId, [id], q);
  if (!dto) throw notFound("Producto no encontrado");
  return dto;
}

/* ------------------------------------------------------------------ *
 * Reglas compartidas
 * ------------------------------------------------------------------ */

function notFound(message: string): CatalogError {
  return new CatalogError(404, "not_found", message);
}

const CODE_INDEXES = ["product_org_code_uq", "product_variant_org_code_uq"];

/** 23505 de uno de los índices de código (directo o en `cause`). */
export function isDuplicateCode(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    constraint_name?: unknown;
    message?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown; message?: unknown };
  } | null;
  if (!e) return false;
  const candidates = [e, e.cause].filter(Boolean) as {
    code?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  }[];
  return candidates.some(
    (c) =>
      c.code === "23505" &&
      (c.constraint_name === undefined ||
        CODE_INDEXES.includes(String(c.constraint_name)) ||
        CODE_INDEXES.some((name) => String(c.message ?? "").includes(name)))
  );
}

function duplicateCode(code: string): CatalogError {
  return new CatalogError(
    409,
    "duplicate_code",
    `El código ${code} ya lo usa otro producto o variante`
  );
}

/**
 * Código libre en la org ENTRE productos y variantes, sin distinguir
 * mayúsculas (FR-904). El índice solo cubre su propia tabla: el candado
 * consultivo por org serializa las altas/ediciones con código para que la
 * verificación cruzada no tenga carrera. Debe llamarse dentro de la
 * transacción que hace el insert/update.
 */
async function assertCodeFree(
  tx: Tx,
  organizationId: string,
  code: string,
  exclude: { productId?: string; variantId?: string } = {}
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`catalog_code:${organizationId}`}))`
  );
  const lc = code.toLowerCase();
  const p = schema.product;
  const v = schema.productVariant;
  const [inProducts, inVariants] = await Promise.all([
    tx
      .select({ id: p.id })
      .from(p)
      .where(
        scoped(
          p.organizationId,
          organizationId,
          sql`lower(${p.code}) = ${lc}`,
          exclude.productId ? ne(p.id, exclude.productId) : undefined
        )
      )
      .limit(1),
    tx
      .select({ id: v.id })
      .from(v)
      .where(
        scoped(
          v.organizationId,
          organizationId,
          sql`lower(${v.code}) = ${lc}`,
          exclude.variantId ? ne(v.id, exclude.variantId) : undefined
        )
      )
      .limit(1),
  ]);
  if (inProducts.length > 0 || inVariants.length > 0) throw duplicateCode(code);
}

async function assertCategory(
  q: Q,
  organizationId: string,
  categoryId: string | null | undefined
): Promise<void> {
  if (!categoryId) return;
  const c = schema.productCategory;
  const rows = await q
    .select({ id: c.id })
    .from(c)
    .where(scoped(c.organizationId, organizationId, eq(c.id, categoryId)))
    .limit(1);
  if (rows.length === 0) throw new CatalogError(422, "invalid_category");
}

async function assertProduct(q: Q, organizationId: string, productId: string) {
  const p = schema.product;
  const rows = await q
    .select({ id: p.id })
    .from(p)
    .where(scoped(p.organizationId, organizationId, eq(p.id, productId)))
    .limit(1);
  if (rows.length === 0) throw notFound("Producto no encontrado");
}

async function assertVariantOf(
  q: Q,
  organizationId: string,
  productId: string,
  variantId: string
): Promise<void> {
  const v = schema.productVariant;
  const rows = await q
    .select({ id: v.id })
    .from(v)
    .where(
      scoped(v.organizationId, organizationId, eq(v.id, variantId), eq(v.productId, productId))
    )
    .limit(1);
  if (rows.length === 0) throw new CatalogError(422, "invalid_variant");
}

/** Ejecuta `fn` traduciendo el 23505 de los índices de código a 409. */
async function withCodeGuard<T>(code: string | null | undefined, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (code && isDuplicateCode(err)) throw duplicateCode(code);
    throw err;
  }
}

/**
 * Borra los bytes de cada archivo en el proveedor donde se guardó
 * (FR-908/912). Best-effort: un fallo se registra (sin claves ni rutas) y
 * no se propaga; la fila ya no existe.
 */
async function removeBlobs(
  rows: ReadonlyArray<Pick<ProductFileRow, "id" | "storageProvider" | "storageKey">>
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      try {
        await getCatalogStorage(row.storageProvider).delete(row.storageKey);
      } catch (err) {
        const code = err instanceof StorageError ? err.code : "error";
        console.error(
          `[catalog] no se pudo borrar el binario de ${row.id} (${row.storageProvider}): ${code}`
        );
      }
    })
  );
}

function filesWhere(organizationId: string, ...conds: Parameters<typeof scoped>[2][]) {
  return scoped(schema.productFile.organizationId, organizationId, ...conds);
}

const blobColumns = {
  id: schema.productFile.id,
  storageProvider: schema.productFile.storageProvider,
  storageKey: schema.productFile.storageKey,
};

/* ------------------------------------------------------------------ *
 * Categorías
 * ------------------------------------------------------------------ */

export async function createCategory(
  organizationId: string,
  input: CategoryCreateBody
): Promise<CatalogCategoryDto> {
  const c = schema.productCategory;
  const rows = await getDb()
    .insert(c)
    .values({
      id: newId("productCategory"),
      organizationId,
      name: input.name,
      position:
        input.position ??
        sql`(select coalesce(max(${c.position}), -1) + 1 from ${c} where ${c.organizationId} = ${organizationId})`,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("insert de product_category sin fila");
  return serializeCategory(row);
}

export async function updateCategory(
  organizationId: string,
  id: string,
  patch: CategoryPatchBody
): Promise<CatalogCategoryDto> {
  const c = schema.productCategory;
  const set: Partial<typeof c.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.position !== undefined) set.position = patch.position;
  const rows = await getDb()
    .update(c)
    .set(set)
    .where(scoped(c.organizationId, organizationId, eq(c.id, id)))
    .returning();
  const row = rows[0];
  if (!row) throw notFound("Categoría no encontrada");
  return serializeCategory(row);
}

/** Sus productos quedan sin categoría (`ON DELETE SET NULL`). */
export async function deleteCategory(organizationId: string, id: string): Promise<void> {
  const c = schema.productCategory;
  const rows = await getDb()
    .delete(c)
    .where(scoped(c.organizationId, organizationId, eq(c.id, id)))
    .returning({ id: c.id });
  if (rows.length === 0) throw notFound("Categoría no encontrada");
}

/* ------------------------------------------------------------------ *
 * Productos
 * ------------------------------------------------------------------ */

export async function createProduct(
  organizationId: string,
  input: ProductCreateBody
): Promise<CatalogProductDto> {
  const p = schema.product;
  return withCodeGuard(input.code, () =>
    getDb().transaction(async (tx) => {
      await assertCategory(tx, organizationId, input.categoryId);
      if (input.code) await assertCodeFree(tx, organizationId, input.code);
      const rows = await tx
        .insert(p)
        .values({
          id: newId("product"),
          organizationId,
          categoryId: input.categoryId ?? null,
          name: input.name,
          code: input.code ?? null,
          price: input.price ?? null,
          description: input.description ?? null,
          attributes: input.attributes ?? [],
          active: input.active ?? true,
          position:
            input.position ??
            sql`(select coalesce(max(${p.position}), -1) + 1 from ${p} where ${p.organizationId} = ${organizationId})`,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert de product sin fila");
      return serializeProduct(row, [], []);
    })
  );
}

export async function updateProduct(
  organizationId: string,
  id: string,
  patch: ProductPatchBody
): Promise<CatalogProductDto> {
  const p = schema.product;
  return withCodeGuard(patch.code, () =>
    getDb().transaction(async (tx) => {
      await assertProduct(tx, organizationId, id);
      if (patch.categoryId !== undefined) {
        await assertCategory(tx, organizationId, patch.categoryId);
      }
      if (patch.code) await assertCodeFree(tx, organizationId, patch.code, { productId: id });

      const set: Partial<typeof p.$inferInsert> = { updatedAt: new Date() };
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.code !== undefined) set.code = patch.code;
      if (patch.price !== undefined) set.price = patch.price;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.attributes !== undefined) set.attributes = patch.attributes;
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.position !== undefined) set.position = patch.position;
      await tx.update(p).set(set).where(scoped(p.organizationId, organizationId, eq(p.id, id)));
      return productDto(organizationId, id, tx);
    })
  );
}

/** Borra variantes y archivos (CASCADE) y luego sus bytes (best-effort). */
export async function deleteProduct(organizationId: string, id: string): Promise<void> {
  const p = schema.product;
  const f = schema.productFile;
  const blobs = await getDb().transaction(async (tx) => {
    // Las claves se leen ANTES: el CASCADE se lleva las filas.
    const files = await tx
      .select(blobColumns)
      .from(f)
      .where(filesWhere(organizationId, eq(f.productId, id)));
    const rows = await tx
      .delete(p)
      .where(scoped(p.organizationId, organizationId, eq(p.id, id)))
      .returning({ id: p.id });
    if (rows.length === 0) throw notFound("Producto no encontrado");
    return files;
  });
  await removeBlobs(blobs);
}

/* ------------------------------------------------------------------ *
 * Variantes
 * ------------------------------------------------------------------ */

export async function createVariant(
  organizationId: string,
  productId: string,
  input: VariantCreateBody
): Promise<CatalogVariantDto> {
  const v = schema.productVariant;
  return withCodeGuard(input.code, () =>
    getDb().transaction(async (tx) => {
      await assertProduct(tx, organizationId, productId);
      if (input.code) await assertCodeFree(tx, organizationId, input.code);
      const rows = await tx
        .insert(v)
        .values({
          id: newId("productVariant"),
          organizationId,
          productId,
          name: input.name,
          code: input.code ?? null,
          price: input.price ?? null,
          attributes: input.attributes ?? [],
          active: input.active ?? true,
          position:
            input.position ??
            sql`(select coalesce(max(${v.position}), -1) + 1 from ${v} where ${v.organizationId} = ${organizationId} and ${v.productId} = ${productId})`,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert de product_variant sin fila");
      return serializeVariant(row);
    })
  );
}

export async function updateVariant(
  organizationId: string,
  id: string,
  patch: VariantPatchBody
): Promise<CatalogVariantDto> {
  const v = schema.productVariant;
  return withCodeGuard(patch.code, () =>
    getDb().transaction(async (tx) => {
      const exists = await tx
        .select({ id: v.id })
        .from(v)
        .where(scoped(v.organizationId, organizationId, eq(v.id, id)))
        .limit(1);
      if (exists.length === 0) throw notFound("Variante no encontrada");
      if (patch.code) await assertCodeFree(tx, organizationId, patch.code, { variantId: id });
      const set: Partial<typeof v.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.code !== undefined) set.code = patch.code;
      if (patch.price !== undefined) set.price = patch.price;
      if (patch.attributes !== undefined) set.attributes = patch.attributes;
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.position !== undefined) set.position = patch.position;
      const rows = await tx
        .update(v)
        .set(set)
        .where(scoped(v.organizationId, organizationId, eq(v.id, id)))
        .returning();
      const row = rows[0];
      if (!row) throw notFound("Variante no encontrada");
      return serializeVariant(row);
    })
  );
}

/** Borra sus archivos propios (CASCADE) y luego sus bytes (best-effort). */
export async function deleteVariant(organizationId: string, id: string): Promise<void> {
  const v = schema.productVariant;
  const f = schema.productFile;
  const blobs = await getDb().transaction(async (tx) => {
    const files = await tx
      .select(blobColumns)
      .from(f)
      .where(filesWhere(organizationId, eq(f.variantId, id)));
    const rows = await tx
      .delete(v)
      .where(scoped(v.organizationId, organizationId, eq(v.id, id)))
      .returning({ id: v.id });
    if (rows.length === 0) throw notFound("Variante no encontrada");
    return files;
  });
  await removeBlobs(blobs);
}

/* ------------------------------------------------------------------ *
 * Archivos
 * ------------------------------------------------------------------ */

export type AddProductFileInput = {
  data: Buffer;
  fileName: string;
  /** MIME que declaró el navegador: solo pista, decide la firma. */
  declaredMime?: string;
  /** Sin variante = compartido por todas. */
  variantId?: string | null;
};

/** Nombre mostrable: sin rutas ni caracteres de control, ≤ 200. */
export function cleanFileName(raw: string | null | undefined, ext: string): string {
  const base = (raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return base || `archivo.${ext}`;
}

/** Guardar con el proveedor actual; su fallo → 503 sin nada en BD. */
function storageFor(provider?: ProductFileRow["storageProvider"]): CatalogStorage {
  try {
    return getCatalogStorage(provider);
  } catch (err) {
    throw storageError(err);
  }
}

function storageError(err: unknown): CatalogError {
  if (err instanceof StorageError) {
    return new CatalogError(503, "storage_unavailable", err.message);
  }
  if (err instanceof CatalogError) return err;
  console.error("[catalog] error inesperado del almacenamiento");
  return new CatalogError(503, "storage_unavailable");
}

/**
 * Alta de un archivo (FR-905): el tipo lo decide la FIRMA. Orden: producto,
 * variante y tope (sin tocar el storage) → política de 018 → `put` → insert.
 * Si el insert falla se borra el blob recién escrito; si el `put` falla no
 * se escribe nada en BD.
 */
export async function addProductFile(
  organizationId: string,
  productId: string,
  input: AddProductFileInput
): Promise<CatalogFileDto> {
  const db = getDb();
  const f = schema.productFile;
  await assertProduct(db, organizationId, productId);
  const variantId = input.variantId || null;
  if (variantId) await assertVariantOf(db, organizationId, productId, variantId);

  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(f)
    .where(filesWhere(organizationId, eq(f.productId, productId)));
  if (n >= CATALOG_LIMITS.maxFilesPerProduct) {
    throw new CatalogError(409, "too_many_files");
  }

  let inspection: ReturnType<typeof inspectOutgoing>;
  try {
    inspection = inspectOutgoing(input.data, {
      fileName: input.fileName,
      mime: input.declaredMime ?? null,
    });
  } catch (err) {
    if (err instanceof MediaValidationError) {
      throw new CatalogError(err.code === "too_large" ? 413 : 415, err.code, err.message);
    }
    throw err;
  }
  const kind = fileKindFor(inspection.mime);
  if (!kind) throw new CatalogError(415, "unsupported_type");

  const id = newId("productFile");
  const storage = storageFor();
  const storageKey = catalogStorageKey(organizationId, id);
  try {
    await storage.put(storageKey, input.data, inspection.mime);
  } catch (err) {
    throw storageError(err);
  }

  try {
    const rows = await db
      .insert(f)
      .values({
        id,
        organizationId,
        productId,
        variantId,
        kind,
        mimeType: inspection.mime,
        fileName: cleanFileName(input.fileName, inspection.ext),
        fileSize: input.data.byteLength,
        storageProvider: storage.provider,
        storageKey,
        position: sql`(select coalesce(max(${f.position}), -1) + 1 from ${f} where ${f.organizationId} = ${organizationId} and ${f.productId} = ${productId})`,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insert de product_file sin fila");
    return serializeProductFile(row);
  } catch (err) {
    await storage.delete(storageKey).catch(() => {
      console.error(`[catalog] no se pudo limpiar el binario huérfano de ${id}`);
    });
    throw err;
  }
}

async function getFileRow(
  q: Q,
  organizationId: string,
  id: string
): Promise<ProductFileRow | null> {
  const f = schema.productFile;
  const rows = await q.select().from(f).where(filesWhere(organizationId, eq(f.id, id))).limit(1);
  return rows[0] ?? null;
}

/** Reordenar o mover entre compartido / variante del MISMO producto. */
export async function updateProductFile(
  organizationId: string,
  id: string,
  patch: ProductFilePatchBody
): Promise<CatalogFileDto> {
  const f = schema.productFile;
  return getDb().transaction(async (tx) => {
    const row = await getFileRow(tx, organizationId, id);
    if (!row) throw notFound("Archivo no encontrado");
    if (patch.variantId) await assertVariantOf(tx, organizationId, row.productId, patch.variantId);
    const set: Partial<typeof f.$inferInsert> = { updatedAt: new Date() };
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.variantId !== undefined) set.variantId = patch.variantId;
    const rows = await tx
      .update(f)
      .set(set)
      .where(filesWhere(organizationId, eq(f.id, id)))
      .returning();
    const updated = rows[0];
    if (!updated) throw notFound("Archivo no encontrado");
    return serializeProductFile(updated);
  });
}

export async function deleteProductFile(organizationId: string, id: string): Promise<void> {
  const f = schema.productFile;
  const rows = await getDb()
    .delete(f)
    .where(filesWhere(organizationId, eq(f.id, id)))
    .returning(blobColumns);
  if (rows.length === 0) throw notFound("Archivo no encontrado");
  await removeBlobs(rows);
}

/**
 * Bytes de un archivo para `GET /api/catalog/files/[id]` (FR-914). null si
 * no es de la org. Fila sin bytes → 410 `file_missing` (el recurso existió y
 * ya no se puede entregar, mismo criterio que el 410 de los adjuntos de 018);
 * proveedor caído o mal configurado → 503 `storage_unavailable`.
 */
export async function getCatalogFileForServing(
  organizationId: string,
  fileId: string
): Promise<{ row: ProductFileRow; data: Buffer } | null> {
  const row = await getCatalogFileRow(organizationId, fileId);
  if (!row) return null;
  try {
    const data = await readCatalogFileData(row);
    return { row, data };
  } catch (err) {
    if (err instanceof CatalogFileError) {
      if (err.code === "file_missing") {
        console.error(`[catalog] ${row.id} sin binario en ${row.storageProvider}`);
        throw new CatalogError(410, "file_missing");
      }
      throw new CatalogError(503, "storage_unavailable", err.message);
    }
    throw storageError(err);
  }
}
