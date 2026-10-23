import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { filesForAttach, type CatalogProductDto } from "@/lib/catalog";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  findUnknownVars,
  quickReplyLinkProblem,
  unknownVariableMessage,
} from "@/lib/quick-replies";
import {
  canCreateQuickReply,
  canEditQuickReply,
  forbiddenQuickReplyFields,
  type QuickReplySellerFields,
  type QuickReplyViewer,
} from "@/lib/quick-reply-policy";
import { isOwner } from "@/lib/roles";
import type {
  QuickReplyCreateBody,
  QuickReplyDto,
  QuickReplyPatchBody,
  QuickReplyProductDto,
} from "@/lib/types";
import { loadProducts } from "@/server/catalog/store";
import { getInboxSettings } from "@/server/inbox/archive";

/**
 * 09 — Catálogo de respuestas rápidas de la organización (RF-09-20/21).
 * Toda query pasa por `scoped(quick_reply.organization_id, …)`. La validación
 * de forma y variables la hace la ruta (`src/lib/quick-replies.ts`); aquí
 * solo vive la persistencia y la traducción del choque de atajo a
 * `duplicate_shortcut`.
 *
 * 019 — Respuestas ligadas a un producto (FR-920..922): `productId` debe ser
 * de la org (422 `invalid_product`). En PATCH las reglas de la liga y de
 * variables se validan aquí sobre el estado FUSIONADO con lo guardado. Cada
 * DTO trae `product` ya resuelto (archivos filtrados por `attach`), cargado
 * en lote: sin N+1.
 *
 * 029 — Respuestas del equipo: create/update/delete reciben el viewer y
 * aplican `src/lib/quick-reply-policy.ts` (403 `forbidden`). El Vendedor crea
 * con el interruptor `inbox_settings.sellers_create_quick_replies` encendido
 * y edita/borra solo las suyas de texto; update/delete leen primero (404 vs
 * 403: la existencia no es secreta, el GET lista todo) y repiten el filtro
 * de autor en el WHERE. Cada DTO trae su autor (`createdByName`).
 */

export class QuickReplyError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "duplicate_shortcut"
      | "not_found"
      | "invalid_product"
      | "invalid_body"
      | "unknown_variable"
      | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "QuickReplyError";
  }
}

type Row = typeof schema.quickReply.$inferSelect;

/** Producto de la respuesta tal cual lo ve el compositor (FR-922). */
export function quickReplyProduct(
  product: CatalogProductDto,
  attach: Row["attach"]
): QuickReplyProductDto {
  return {
    id: product.id,
    name: product.name,
    code: product.code,
    active: product.active,
    files: attach ? filesForAttach(product, attach) : [],
  };
}

export function serializeQuickReply(
  r: Row,
  product: CatalogProductDto | null = null,
  createdByName: string | null = null
): QuickReplyDto {
  return {
    id: r.id,
    shortcut: r.shortcut,
    title: r.title,
    body: r.body,
    position: r.position,
    productId: r.productId,
    // Sin producto no hay `attach` (defensa ante un SET NULL del FK).
    attach: r.productId ? r.attach : null,
    product: product && r.productId === product.id ? quickReplyProduct(product, r.attach) : null,
    createdByUserId: r.createdByUserId,
    createdByName: r.createdByUserId ? createdByName : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 029: fila con el nombre del autor ya resuelto (join del listado). */
type RowWithAuthor = Row & { createdByName?: string | null };

/**
 * Serializa en lote: una sola carga de productos/variantes/archivos. 029: el
 * listado trae el autor por join; las filas sueltas (alta/edición) lo
 * resuelven aquí con una sola consulta a `user`.
 */
async function serializeMany(
  organizationId: string,
  rows: RowWithAuthor[]
): Promise<QuickReplyDto[]> {
  const ids = rows.map((r) => r.productId).filter((id): id is string => !!id);
  const products = new Map(
    (await loadProducts(organizationId, ids)).map((p) => [p.id, p] as const)
  );
  const missing = [
    ...new Set(
      rows
        .filter((r) => r.createdByName === undefined)
        .map((r) => r.createdByUserId)
        .filter((id): id is string => !!id)
    ),
  ];
  const names = new Map<string, string>();
  if (missing.length > 0) {
    // `user` es la tabla global de Better Auth (sin organization_id): solo se
    // buscan los autores de filas YA filtradas por la org.
    const u = schema.user;
    const found = await getDb()
      .select({ id: u.id, name: u.name })
      .from(u)
      .where(inArray(u.id, missing));
    for (const row of found) names.set(row.id, row.name);
  }
  return rows.map((r) =>
    serializeQuickReply(
      r,
      r.productId ? (products.get(r.productId) ?? null) : null,
      r.createdByName !== undefined
        ? r.createdByName
        : r.createdByUserId
          ? (names.get(r.createdByUserId) ?? null)
          : null
    )
  );
}

/** 23505 = unique_violation; solo cuenta si es el índice del atajo. */
export function isDuplicateShortcut(err: unknown): boolean {
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
        c.constraint_name === "quick_reply_org_shortcut_uq" ||
        String(c.message ?? "").includes("quick_reply_org_shortcut_uq"))
  );
}

/** 23503 de la FK a producto: lo borraron entre la verificación y el write. */
function isMissingProduct(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown; cause?: unknown } | null;
  if (!e) return false;
  return [e, e.cause as typeof e].some(
    (c) =>
      !!c &&
      c.code === "23503" &&
      (c.constraint_name === undefined ||
        c.constraint_name === "quick_reply_product_id_product_id_fk")
  );
}

function duplicate(shortcut: string): QuickReplyError {
  return new QuickReplyError(
    409,
    "duplicate_shortcut",
    `Ya existe una respuesta rápida con el atajo /${shortcut}`
  );
}

function invalidProduct(): QuickReplyError {
  return new QuickReplyError(422, "invalid_product", "El producto no existe");
}

async function assertProduct(organizationId: string, productId: string): Promise<void> {
  const p = schema.product;
  const rows = await getDb()
    .select({ id: p.id })
    .from(p)
    .where(scoped(p.organizationId, organizationId, eq(p.id, productId)))
    .limit(1);
  if (rows.length === 0) throw invalidProduct();
}

/** Catálogo por `position` asc, luego `createdAt` asc. 029: con su autor. */
export async function listQuickReplies(
  organizationId: string
): Promise<QuickReplyDto[]> {
  const q = schema.quickReply;
  const u = schema.user;
  const rows = await getDb()
    .select({ row: q, createdByName: u.name })
    .from(q)
    .leftJoin(u, eq(u.id, q.createdByUserId))
    .where(scoped(q.organizationId, organizationId))
    .orderBy(asc(q.position), asc(q.createdAt), asc(q.id));
  return serializeMany(
    organizationId,
    rows.map((r) => ({ ...r.row, createdByName: r.createdByName ?? null }))
  );
}

/** 029: ¿el interruptor deja escribir a los Vendedores? (sin fila = sí). */
async function sellersEnabled(organizationId: string): Promise<boolean> {
  return (await getInboxSettings(organizationId)).sellersCreateQuickReplies;
}

/** 029: ¿este viewer puede crear? El Propietario no lee los ajustes. */
export async function viewerCanCreateQuickReply(
  organizationId: string,
  viewer: QuickReplyViewer
): Promise<boolean> {
  if (isOwner(viewer.role)) return true;
  return canCreateQuickReply(viewer, await sellersEnabled(organizationId));
}

function forbidden(message: string): QuickReplyError {
  return new QuickReplyError(403, "forbidden", message);
}

const FORBIDDEN_FIELD_LABEL = {
  productId: "el producto",
  attach: "los archivos del producto",
  position: "el orden",
} as const;

/** 403 si el Vendedor manda campos del Propietario (producto, orden). */
function assertSellerFields(viewer: QuickReplyViewer, input: QuickReplySellerFields): void {
  const fields = forbiddenQuickReplyFields(viewer, input);
  if (fields.length > 0) {
    const what = fields.map((f) => FORBIDDEN_FIELD_LABEL[f]).join(", ");
    throw forbidden(`Solo el Propietario puede cambiar ${what}`);
  }
}

/**
 * 029 — Lee la fila (404 si no es de la org) y aplica `canEditQuickReply`
 * (403 si el Vendedor no puede tocarla).
 */
async function loadEditable(
  organizationId: string,
  viewer: QuickReplyViewer,
  id: string
): Promise<Row> {
  const q = schema.quickReply;
  const current = (
    await getDb()
      .select()
      .from(q)
      .where(scoped(q.organizationId, organizationId, eq(q.id, id)))
      .limit(1)
  )[0];
  if (!current) throw notFound();
  if (!isOwner(viewer.role)) {
    const enabled = await sellersEnabled(organizationId);
    if (!canEditQuickReply(viewer, current, enabled)) {
      throw forbidden(
        enabled
          ? "Solo puedes editar o borrar tus respuestas rápidas de texto"
          : "El Propietario desactivó que los vendedores editen respuestas rápidas"
      );
    }
  }
  return current;
}

/**
 * WHERE de la escritura: org + id y, para el Vendedor, otra vez autor y sin
 * producto (si cambió entre la lectura y la escritura: 404, nunca pisar).
 */
function writeFilter(organizationId: string, viewer: QuickReplyViewer, id: string) {
  const q = schema.quickReply;
  if (isOwner(viewer.role)) return scoped(q.organizationId, organizationId, eq(q.id, id));
  return scoped(
    q.organizationId,
    organizationId,
    and(eq(q.id, id), eq(q.createdByUserId, viewer.userId), isNull(q.productId))
  );
}

/**
 * Alta. `shortcut` llega ya normalizado y la forma (liga ambos-o-ninguno,
 * variables) ya validada por la ruta. Sin `position` → al final
 * (`max(position) + 1` de la org, en la misma sentencia). Atajo repetido →
 * 409 `duplicate_shortcut` (lo decide el índice único, no una lectura previa).
 */
export async function createQuickReply(
  organizationId: string,
  viewer: QuickReplyViewer,
  input: QuickReplyCreateBody
): Promise<QuickReplyDto> {
  const q = schema.quickReply;
  if (!(await viewerCanCreateQuickReply(organizationId, viewer))) {
    throw forbidden("El Propietario desactivó que los vendedores creen respuestas rápidas");
  }
  assertSellerFields(viewer, input);
  const productId = input.productId ?? null;
  if (productId) await assertProduct(organizationId, productId);
  try {
    const rows = await getDb()
      .insert(q)
      .values({
        id: newId("quickReply"),
        organizationId,
        shortcut: input.shortcut,
        title: input.title,
        body: input.body,
        productId,
        attach: productId ? (input.attach ?? null) : null,
        position:
          input.position ??
          sql`(select coalesce(max(${q.position}), -1) + 1 from ${q} where ${q.organizationId} = ${organizationId})`,
        createdByUserId: viewer.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insert de quick_reply sin fila");
    const [dto] = await serializeMany(organizationId, [row]);
    return dto!;
  } catch (err) {
    if (isDuplicateShortcut(err)) throw duplicate(input.shortcut);
    if (isMissingProduct(err)) throw invalidProduct();
    throw err;
  }
}

/**
 * Edición parcial (reordenar = cambiar `position`). 404 si no es de la org.
 * 019: valida la liga a producto y las variables sobre el estado fusionado
 * (lo guardado + el PATCH): 422 `invalid_body` / `unknown_variable` /
 * `invalid_product`.
 */
export async function updateQuickReply(
  organizationId: string,
  viewer: QuickReplyViewer,
  id: string,
  patch: QuickReplyPatchBody
): Promise<QuickReplyDto> {
  const q = schema.quickReply;
  const current = await loadEditable(organizationId, viewer, id);
  assertSellerFields(viewer, patch);

  const productId = patch.productId !== undefined ? patch.productId : current.productId;
  const attach =
    patch.productId === null
      ? null
      : patch.attach !== undefined
        ? patch.attach
        : current.productId
          ? current.attach
          : null;
  const body = patch.body !== undefined ? patch.body : current.body;

  const problem = quickReplyLinkProblem({ body, productId, attach });
  if (problem) throw new QuickReplyError(422, "invalid_body", problem);
  const unknown = findUnknownVars(body, { product: !!productId });
  if (unknown.length > 0) {
    throw new QuickReplyError(422, "unknown_variable", unknownVariableMessage(unknown));
  }
  if (productId && productId !== current.productId) {
    await assertProduct(organizationId, productId);
  }

  const set: Partial<typeof q.$inferInsert> = { updatedAt: new Date() };
  if (patch.shortcut !== undefined) set.shortcut = patch.shortcut;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.productId !== undefined || patch.attach !== undefined) {
    set.productId = productId;
    set.attach = attach;
  }
  try {
    const rows = await getDb()
      .update(q)
      .set(set)
      .where(writeFilter(organizationId, viewer, id))
      .returning();
    const row = rows[0];
    if (!row) throw notFound();
    const [dto] = await serializeMany(organizationId, [row]);
    return dto!;
  } catch (err) {
    if (isDuplicateShortcut(err)) throw duplicate(patch.shortcut ?? "");
    if (isMissingProduct(err)) throw invalidProduct();
    throw err;
  }
}

export async function deleteQuickReply(
  organizationId: string,
  viewer: QuickReplyViewer,
  id: string
): Promise<void> {
  const q = schema.quickReply;
  await loadEditable(organizationId, viewer, id);
  const rows = await getDb()
    .delete(q)
    .where(writeFilter(organizationId, viewer, id))
    .returning({ id: q.id });
  if (rows.length === 0) throw notFound();
}

function notFound(): QuickReplyError {
  return new QuickReplyError(404, "not_found", "Respuesta rápida no encontrada");
}
