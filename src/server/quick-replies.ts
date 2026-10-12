import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type {
  QuickReplyCreateBody,
  QuickReplyDto,
  QuickReplyPatchBody,
} from "@/lib/types";

/**
 * 09 — Catálogo de respuestas rápidas de la organización (RF-09-20/21).
 * Toda query pasa por `scoped(quick_reply.organization_id, …)`. La validación
 * de forma y variables la hace la ruta (`src/lib/quick-replies.ts`); aquí
 * solo vive la persistencia y la traducción del choque de atajo a
 * `duplicate_shortcut`.
 */

export class QuickReplyError extends Error {
  constructor(
    readonly status: number,
    readonly code: "duplicate_shortcut" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "QuickReplyError";
  }
}

type Row = typeof schema.quickReply.$inferSelect;

export function serializeQuickReply(r: Row): QuickReplyDto {
  return {
    id: r.id,
    shortcut: r.shortcut,
    title: r.title,
    body: r.body,
    position: r.position,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
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

function duplicate(shortcut: string): QuickReplyError {
  return new QuickReplyError(
    409,
    "duplicate_shortcut",
    `Ya existe una respuesta rápida con el atajo /${shortcut}`
  );
}

/** Catálogo por `position` asc, luego `createdAt` asc. */
export async function listQuickReplies(
  organizationId: string
): Promise<QuickReplyDto[]> {
  const q = schema.quickReply;
  const rows = await getDb()
    .select()
    .from(q)
    .where(scoped(q.organizationId, organizationId))
    .orderBy(asc(q.position), asc(q.createdAt), asc(q.id));
  return rows.map(serializeQuickReply);
}

/**
 * Alta. `shortcut` llega ya normalizado. Sin `position` → al final
 * (`max(position) + 1` de la org, en la misma sentencia). Atajo repetido →
 * 409 `duplicate_shortcut` (lo decide el índice único, no una lectura previa).
 */
export async function createQuickReply(
  organizationId: string,
  userId: string,
  input: QuickReplyCreateBody
): Promise<QuickReplyDto> {
  const q = schema.quickReply;
  try {
    const rows = await getDb()
      .insert(q)
      .values({
        id: newId("quickReply"),
        organizationId,
        shortcut: input.shortcut,
        title: input.title,
        body: input.body,
        position:
          input.position ??
          sql`(select coalesce(max(${q.position}), -1) + 1 from ${q} where ${q.organizationId} = ${organizationId})`,
        createdByUserId: userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insert de quick_reply sin fila");
    return serializeQuickReply(row);
  } catch (err) {
    if (isDuplicateShortcut(err)) throw duplicate(input.shortcut);
    throw err;
  }
}

/** Edición parcial (reordenar = cambiar `position`). 404 si no es de la org. */
export async function updateQuickReply(
  organizationId: string,
  id: string,
  patch: QuickReplyPatchBody
): Promise<QuickReplyDto> {
  const q = schema.quickReply;
  const set: Partial<typeof q.$inferInsert> = { updatedAt: new Date() };
  if (patch.shortcut !== undefined) set.shortcut = patch.shortcut;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.position !== undefined) set.position = patch.position;
  try {
    const rows = await getDb()
      .update(q)
      .set(set)
      .where(scoped(q.organizationId, organizationId, eq(q.id, id)))
      .returning();
    const row = rows[0];
    if (!row) throw notFound();
    return serializeQuickReply(row);
  } catch (err) {
    if (isDuplicateShortcut(err)) throw duplicate(patch.shortcut ?? "");
    throw err;
  }
}

export async function deleteQuickReply(
  organizationId: string,
  id: string
): Promise<void> {
  const q = schema.quickReply;
  const rows = await getDb()
    .delete(q)
    .where(scoped(q.organizationId, organizationId, eq(q.id, id)))
    .returning({ id: q.id });
  if (rows.length === 0) throw notFound();
}

function notFound(): QuickReplyError {
  return new QuickReplyError(404, "not_found", "Respuesta rápida no encontrada");
}
