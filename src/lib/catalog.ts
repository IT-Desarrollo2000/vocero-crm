/**
 * 019 — Catálogo de productos: contrato compartido por servidor (validación,
 * store, envío) y cliente (página Catálogo, compositor). Sin dependencias de
 * servidor: nada de `Buffer`, `fs` ni `file-policy.ts` (las listas de MIME
 * detectados se replican aquí y un test vigila que sigan en sincronía).
 *
 * Funciones puras: `fileKindFor`, `filesForAttach`, `filesForVariant`,
 * `defaultShortcutsFor`, `fileCompatibility`, `productDetailsText`. Esquemas
 * Zod de categoría/producto/variante y del lote de envío (`catalogBatchSchema`).
 */

import { z } from "zod";
import type { OutboundFiles } from "./outbound-files";
import { QUICK_REPLY_LIMITS } from "./quick-replies";

/* ------------------------------------------------------------------ *
 * Límites (FR-901..905)
 * ------------------------------------------------------------------ */

export const CATALOG_LIMITS = {
  categoryNameMax: 60,
  productNameMax: 120,
  variantNameMax: 80,
  /** Código de producto o variante; único por org sin distinguir mayúsculas. */
  codePattern: /^[A-Za-z0-9_-]{1,32}$/,
  priceMax: 60,
  descriptionMax: 4000,
  attributesMax: 30,
  attributeLabelMax: 40,
  attributeValueMax: 200,
  maxFilesPerProduct: 20,
  /** Archivos por envío (`POST …/messages/catalog`). */
  maxBatchFiles: 10,
  /** Texto que acompaña al lote: mismo tope que el envío de texto. */
  batchTextMax: 4096,
} as const;

/**
 * Código más largo que admite "Crear atajos": el atajo `ficha_<code>` /
 * `fotos_<code>` debe cumplir `QUICK_REPLY_LIMITS.shortcutPattern` (≤ 32), y
 * el prefijo ocupa 6. Con un código más largo `defaultShortcutsFor` → null.
 */
export const SHORTCUT_CODE_MAX = 26;

/* ------------------------------------------------------------------ *
 * Tipos y DTOs
 * ------------------------------------------------------------------ */

/** Tipo de un archivo del catálogo, decidido por la firma (FR-905). */
export type CatalogFileKind = "image" | "document";

/** Qué archivos manda una respuesta rápida ligada a un producto (FR-920). */
export type QuickReplyAttach = "images" | "documents" | "all";

export const QUICK_REPLY_ATTACH = ["images", "documents", "all"] as const;

/** Dónde vive el binario de un `product_file` (FR-912). */
export type CatalogStorageProvider = "local" | "azure-blob";

export type ProductAttribute = { label: string; value: string };

export type CatalogFileDto = {
  id: string;
  productId: string;
  /** null = compartido por todas las variantes. */
  variantId: string | null;
  kind: CatalogFileKind;
  /** MIME DETECTADO por firma (el único que se guarda y se sirve). */
  mimeType: string;
  fileName: string;
  /** Bytes. */
  size: number;
  position: number;
  /** `/api/catalog/files/${id}` (ver `catalogFileUrl`). */
  url: string;
};

export type CatalogVariantDto = {
  id: string;
  productId: string;
  name: string;
  code: string | null;
  /** null = hereda el precio del producto al mostrarse. */
  price: string | null;
  attributes: ProductAttribute[];
  active: boolean;
  position: number;
};

export type CatalogProductDto = {
  id: string;
  categoryId: string | null;
  name: string;
  code: string | null;
  price: string | null;
  description: string | null;
  attributes: ProductAttribute[];
  active: boolean;
  position: number;
  /** Ordenadas por `position`. */
  variants: CatalogVariantDto[];
  /** Compartidos y de variantes, ordenados por `position`. */
  files: CatalogFileDto[];
};

export type CatalogCategoryDto = {
  id: string;
  name: string;
  position: number;
};

/** `GET /api/catalog`. */
export type CatalogDto = {
  categories: CatalogCategoryDto[];
  products: CatalogProductDto[];
  /** Proveedor con el que se guardan los archivos NUEVOS (FR-913). */
  storage: { provider: CatalogStorageProvider };
};

export type CatalogBatchItemStatus = "sent" | "skipped" | "failed";

/** Respuesta de `POST /api/conversations/:id/messages/catalog` (FR-941). */
export type CatalogBatchResult = {
  text?: { messageId: string };
  results: Array<{
    fileId: string;
    status: CatalogBatchItemStatus;
    messageId?: string;
    /** Código (`not_found`, `file_missing`, …) o razón legible del 413/415. */
    reason?: string;
  }>;
  /** Código que detuvo el lote (`window_closed`, `sandbox_violation`, …). */
  stopped?: string;
};

export function catalogFileUrl(fileId: string): string {
  return `/api/catalog/files/${fileId}`;
}

/* ------------------------------------------------------------------ *
 * Zod (todo input externo)
 * ------------------------------------------------------------------ */

/** "" o espacios → null; así un campo vacío del formulario BORRA el valor. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));
}

const codeSchema = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v == null || CATALOG_LIMITS.codePattern.test(v), {
    message: "Código inválido: 1-32 letras, números, guion o guion bajo",
  });

export const productAttributeSchema = z.object({
  label: z.string().trim().min(1).max(CATALOG_LIMITS.attributeLabelMax),
  value: z.string().trim().min(1).max(CATALOG_LIMITS.attributeValueMax),
});

const attributesSchema = z
  .array(productAttributeSchema)
  .max(CATALOG_LIMITS.attributesMax);

const positionSchema = z.number().int().min(0);

const atLeastOne = {
  message: "Envía al menos un campo",
};

function hasAnyField(v: Record<string, unknown>): boolean {
  return Object.values(v).some((x) => x !== undefined);
}

/* ---------- Categoría ---------- */

const categoryFields = {
  name: z.string().trim().min(1).max(CATALOG_LIMITS.categoryNameMax),
  position: positionSchema,
};

/** `POST /api/catalog/categories`. */
export const categoryCreateSchema = z.object({
  name: categoryFields.name,
  position: categoryFields.position.optional(),
});

/** `PATCH /api/catalog/categories/[id]` (al menos un campo). */
export const categoryPatchSchema = z
  .object({
    name: categoryFields.name.optional(),
    position: categoryFields.position.optional(),
  })
  .refine(hasAnyField, atLeastOne);

/* ---------- Producto ---------- */

/**
 * En create y patch: `undefined` = no se toca; `null` (o "") = se borra.
 * `code` conserva sus mayúsculas; la unicidad es `lower(code)` en BD.
 */
const productFields = {
  categoryId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(CATALOG_LIMITS.productNameMax),
  code: codeSchema,
  price: optionalText(CATALOG_LIMITS.priceMax),
  description: optionalText(CATALOG_LIMITS.descriptionMax),
  attributes: attributesSchema,
  active: z.boolean(),
  position: positionSchema,
};

/** `POST /api/catalog/products`. */
export const productCreateSchema = z.object({
  categoryId: productFields.categoryId,
  name: productFields.name,
  code: productFields.code,
  price: productFields.price,
  description: productFields.description,
  attributes: productFields.attributes.optional(),
  active: productFields.active.optional(),
  position: productFields.position.optional(),
});

/** `PATCH /api/catalog/products/[id]` (al menos un campo). */
export const productPatchSchema = z
  .object({
    categoryId: productFields.categoryId,
    name: productFields.name.optional(),
    code: productFields.code,
    price: productFields.price,
    description: productFields.description,
    attributes: productFields.attributes.optional(),
    active: productFields.active.optional(),
    position: productFields.position.optional(),
  })
  .refine(hasAnyField, atLeastOne);

/* ---------- Variante ---------- */

const variantFields = {
  name: z.string().trim().min(1).max(CATALOG_LIMITS.variantNameMax),
  code: codeSchema,
  /** null = hereda el del producto. */
  price: optionalText(CATALOG_LIMITS.priceMax),
  attributes: attributesSchema,
  active: z.boolean(),
  position: positionSchema,
};

/** `POST /api/catalog/products/[id]/variants`. */
export const variantCreateSchema = z.object({
  name: variantFields.name,
  code: variantFields.code,
  price: variantFields.price,
  attributes: variantFields.attributes.optional(),
  active: variantFields.active.optional(),
  position: variantFields.position.optional(),
});

/** `PATCH /api/catalog/variants/[id]` (al menos un campo). */
export const variantPatchSchema = z
  .object({
    name: variantFields.name.optional(),
    code: variantFields.code,
    price: variantFields.price,
    attributes: variantFields.attributes.optional(),
    active: variantFields.active.optional(),
    position: variantFields.position.optional(),
  })
  .refine(hasAnyField, atLeastOne);

/* ---------- Archivo ---------- */

/**
 * `PATCH /api/catalog/files/[id]` (al menos un campo). `variantId` null =
 * pasa a compartido; una variante de OTRO producto → 422 en el store.
 */
export const productFilePatchSchema = z
  .object({
    position: positionSchema.optional(),
    variantId: z.string().min(1).nullable().optional(),
  })
  .refine(hasAnyField, atLeastOne);

/* ---------- Lote de envío ---------- */

/**
 * `POST /api/conversations/[id]/messages/catalog` (FR-933). `text` vacío o
 * solo espacios → sin texto. Los `fileIds` se envían en el orden recibido.
 */
export const catalogBatchSchema = z.object({
  text: z
    .string()
    .trim()
    .max(CATALOG_LIMITS.batchTextMax)
    .optional()
    .transform((v) => (v ? v : undefined)),
  fileIds: z
    .array(z.string().min(1))
    .min(1)
    .max(CATALOG_LIMITS.maxBatchFiles),
});

export type CategoryCreateBody = z.infer<typeof categoryCreateSchema>;
export type CategoryPatchBody = z.infer<typeof categoryPatchSchema>;
export type ProductCreateBody = z.infer<typeof productCreateSchema>;
export type ProductPatchBody = z.infer<typeof productPatchSchema>;
export type VariantCreateBody = z.infer<typeof variantCreateSchema>;
export type VariantPatchBody = z.infer<typeof variantPatchSchema>;
export type ProductFilePatchBody = z.infer<typeof productFilePatchSchema>;
export type CatalogBatchBody = z.infer<typeof catalogBatchSchema>;

/* ------------------------------------------------------------------ *
 * Funciones puras
 * ------------------------------------------------------------------ */

/**
 * MIME detectados (por `inspectOutgoing` de `file-policy.ts`) que acepta el
 * catálogo. Réplica de los valores de file-policy: un test los compara.
 */
export const CATALOG_IMAGE_MIMES: readonly string[] = ["image/jpeg", "image/png"];
export const CATALOG_DOCUMENT_MIMES: readonly string[] = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
];

/**
 * Tipo de catálogo para un MIME DETECTADO por firma; null = no entra en el
 * catálogo (gif, webp, audio, video… → 415 con razón en el store).
 */
export function fileKindFor(detectedMime: string): CatalogFileKind | null {
  const mime = detectedMime.split(";")[0]!.trim().toLowerCase();
  if (CATALOG_IMAGE_MIMES.includes(mime)) return "image";
  if (CATALOG_DOCUMENT_MIMES.includes(mime)) return "document";
  return null;
}

type ProductFilesView = {
  variants: ReadonlyArray<Pick<CatalogVariantDto, "id" | "active" | "position">>;
  files: readonly CatalogFileDto[];
};

function byPosition(a: { position: number; id: string }, b: { position: number; id: string }) {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const ATTACH_KINDS: Record<QuickReplyAttach, ReadonlySet<CatalogFileKind>> = {
  images: new Set(["image"]),
  documents: new Set(["document"]),
  all: new Set(["image", "document"]),
};

/**
 * Archivos de un atajo ligado a producto (FR-920): los compartidos y los de
 * variantes ACTIVAS, filtrados por `attach`. Orden: compartidos por
 * `position`; luego por variante (`position` de la variante) y dentro de cada
 * una por `position` del archivo. No mira `product.active`: decidir si un
 * producto inactivo ofrece atajo es de quien llama (FR-907).
 */
export function filesForAttach(
  product: ProductFilesView,
  attach: QuickReplyAttach
): CatalogFileDto[] {
  const kinds = ATTACH_KINDS[attach];
  const variants = [...product.variants].filter((v) => v.active).sort(byPosition);
  const wanted = product.files.filter((f) => kinds.has(f.kind));
  const shared = wanted.filter((f) => f.variantId === null).sort(byPosition);
  const perVariant = variants.flatMap((v) =>
    wanted.filter((f) => f.variantId === v.id).sort(byPosition)
  );
  return [...shared, ...perVariant];
}

/**
 * Archivos que ofrece el botón Catálogo (FR-931): compartidos y, si se eligió
 * variante, los de esa variante. `variantId` null = solo compartidos.
 */
export function filesForVariant(
  product: Pick<ProductFilesView, "files">,
  variantId: string | null
): CatalogFileDto[] {
  const shared = product.files.filter((f) => f.variantId === null).sort(byPosition);
  if (variantId === null) return shared;
  const own = product.files.filter((f) => f.variantId === variantId).sort(byPosition);
  return [...shared, ...own];
}

export type DefaultShortcut = {
  shortcut: string;
  title: string;
  attach: QuickReplyAttach;
  body: string;
};

/**
 * "Crear atajos" (FR-924): `fotos_<code>` (imágenes) y `ficha_<code>`
 * (documentos), en minúsculas. null si el producto no tiene código o el
 * código pasa de `SHORTCUT_CODE_MAX` (el atajo no cabría en 32; recortar
 * podría chocar con el de otro producto). El título se recorta al tope de
 * las respuestas rápidas. Los cuerpos usan `{{producto}}`.
 */
export function defaultShortcutsFor(product: {
  name: string;
  code: string | null;
}): DefaultShortcut[] | null {
  const code = product.code?.trim().toLowerCase() ?? "";
  if (!code || code.length > SHORTCUT_CODE_MAX) return null;
  const title = (s: string) => s.slice(0, QUICK_REPLY_LIMITS.titleMax).trimEnd();
  const out: DefaultShortcut[] = [
    {
      shortcut: `fotos_${code}`,
      title: title(`Fotos ${product.name}`),
      attach: "images",
      body: "Te comparto las fotos de {{producto}}",
    },
    {
      shortcut: `ficha_${code}`,
      title: title(`Ficha técnica ${product.name}`),
      attach: "documents",
      body: "Te comparto la ficha técnica de {{producto}}",
    },
  ];
  return out.every((s) => QUICK_REPLY_LIMITS.shortcutPattern.test(s.shortcut))
    ? out
    : null;
}

export type FileCompatibility = { ok: true } | { ok: false; reason: string };

/**
 * ¿Puede salir este archivo por el canal de la conversación? (FR-932). Misma
 * decisión que `checkChannelFile` del envío, sin bytes: regla por MIME
 * detectado y tope por tamaño. `outboundFiles` es el de `ConversationDto`
 * (null = el canal no manda archivos). La razón se muestra tal cual.
 */
export function fileCompatibility(
  file: Pick<CatalogFileDto, "mimeType" | "size">,
  outboundFiles: OutboundFiles | null
): FileCompatibility {
  if (!outboundFiles) {
    return { ok: false, reason: "Este canal no permite enviar archivos desde el CRM" };
  }
  const rule = outboundFiles.rules.find((r) => r.mimes.includes(file.mimeType));
  if (!rule) return { ok: false, reason: outboundFiles.hint };
  if (file.size > rule.maxBytes) {
    return { ok: false, reason: `Supera el límite de ${rule.label}` };
  }
  return { ok: true };
}

/**
 * "Insertar detalles" (FR-931): `Nombre · Variante · Precio` y debajo una
 * línea `Label: value` por atributo (los del producto y luego los de la
 * variante). El precio es el de la variante o, si no tiene, el del producto.
 */
export function productDetailsText(
  product: Pick<CatalogProductDto, "name" | "price" | "attributes">,
  variant?: Pick<CatalogVariantDto, "name" | "price" | "attributes"> | null
): string {
  const price = variant?.price ?? product.price;
  const head = [product.name, variant?.name, price]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join(" · ");
  const attrs = [...product.attributes, ...(variant?.attributes ?? [])].map(
    (a) => `${a.label}: ${a.value}`
  );
  return [head, ...attrs].join("\n");
}
