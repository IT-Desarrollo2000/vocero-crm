import {
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner } from "@/lib/roles";
import { publish } from "@/server/events/bus";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { capabilitiesFor, replyModeFor } from "@/server/channels/capabilities";
import { conversationVisibleTo, type Viewer } from "@/server/inbox/visibility";
import { inboxOrderBy, type InboxQuery } from "@/server/inbox/list-query";
import type {
  AssignedFilter,
  ConversationDto,
  ConversationsPage,
} from "@/lib/types";

/**
 * Opciones de `listConversations` (contrato 06-0, dev-tasks/06). Todo es
 * opcional: sin nada = lista completa visible (D-06-1). `since` = catch-up
 * legado (solo las actualizadas después de ese instante).
 */
export type ListConversationsOptions = Partial<InboxQuery> & {
  /**
   * 09 (RF-09-12): filtro de responsable, SIEMPRE dentro de lo visible.
   * `me` = asignadas a `viewer.userId`; `unassigned` = sin responsable;
   * `all` (default) = todo lo visible.
   */
  assigned?: AssignedFilter;
};

/** Responsable resuelto para el DTO (null = sin asignar). */
export type Assignee = { userId: string; name: string } | null;

function assignedCondition(
  viewer: Viewer,
  assigned: AssignedFilter | undefined
): SQL | undefined {
  if (assigned === "me") {
    return eq(schema.conversation.assignedUserId, viewer.userId);
  }
  if (assigned === "unassigned") return isNull(schema.conversation.assignedUserId);
  return undefined;
}

function assigneeOf(
  c: typeof schema.conversation.$inferSelect,
  name: string | null
): Assignee {
  return c.assignedUserId ? { userId: c.assignedUserId, name: name ?? "" } : null;
}

/**
 * Lista de la Bandeja (sin `is_test`) para `viewer` (RF-09-02). La
 * visibilidad y el filtro `assigned` van en el WHERE: 06 pagina SOBRE esta
 * misma query, sin reimplementar el predicado.
 *
 * 06-0: firma y forma de respuesta FIJADAS (`{ conversations, nextCursor }`).
 * Por ahora solo implementa `since` y `assigned` (lista completa,
 * `nextCursor: null`); `limit`/`cursor`/`filter`/`stageId`/`channel`/`q`/
 * `ids`/`contactId` los implementa 06-A según el "Contrato 06-0".
 */
export async function listConversations(
  organizationId: string,
  viewer: Viewer,
  opts: ListConversationsOptions = {}
): Promise<ConversationsPage> {
  const { since, assigned } = opts;
  const db = getDb();
  const previewSql = sql<string | null>`(
    select coalesce(m.text, m.type)
    from message m
    where m.conversation_id = ${schema.conversation.id}
    order by m.created_at desc
    limit 1
  )`;
  const stageSql = sql<string | null>`(
    select s.name from lead l
    join pipeline_stage s on s.id = l.stage_id
    where l.contact_id = ${schema.contact.id}
    limit 1
  )`;

  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      preview: previewSql,
      stageName: stageSql,
      assigneeName: schema.user.name,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(
      schema.user,
      eq(schema.user.id, schema.conversation.assignedUserId)
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        conversationVisibleTo(viewer),
        assignedCondition(viewer, assigned),
        since ? gt(schema.conversation.updatedAt, since) : undefined
      )
    )
    // 06: mismo texto que el índice `conversation_org_sort_idx` (0016).
    .orderBy(...inboxOrderBy);

  const conversations = rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      r.preview,
      r.stageName,
      assigneeOf(r.conversation, r.assigneeName)
    )
  );
  return { conversations, nextCursor: null };
}

/**
 * Conversación + contacto (+ responsable) por id.
 *
 * 09: `viewer` aplica la visibilidad en el WHERE (no visible → null → 404).
 * Obligatorio en rutas de sesión; los llamadores internos sin sesión (agente,
 * cerebro externo, mocks) lo omiten. 09-A lo cablea en messages/media/template
 * (y lo vigila `assignment-guard.test.ts`).
 */
export async function getConversation(
  organizationId: string,
  conversationId: string,
  viewer?: Viewer
) {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      assigneeName: schema.user.name,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(
      schema.user,
      eq(schema.user.id, schema.conversation.assignedUserId)
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        viewer ? conversationVisibleTo(viewer) : undefined
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    conversation: row.conversation,
    contact: row.contact,
    assignee: assigneeOf(row.conversation, row.assigneeName),
  };
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(schema.message.createdAt);
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  assignee: Assignee = null,
  /** 06: lo llena 06-A desde el JOIN con `lead`; null mientras tanto. */
  stageId: string | null = null
): ConversationDto {
  return {
    id: c.id,
    channel: c.channel,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    stageName,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    handoffNote: c.handoffNote,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unreadCount: c.unreadCount,
    windowOpen: isWindowOpen(c.lastInboundAt),
    windowRemainingMs: windowRemainingMs(c.lastInboundAt),
    replyMode: replyModeFor(c.channel, c.lastInboundAt),
    outboundMedia: capabilitiesFor(c.channel).outboundMedia,
    templates: capabilitiesFor(c.channel).templates,
    preview,
    assignedTo: assignee,
    assignedAt: assignee ? (c.assignedAt?.toISOString() ?? null) : null,
    sortAt: (c.lastMessageAt ?? c.createdAt).toISOString(),
    stageId,
  };
}

/**
 * PATCH de la Bandeja (IA, reactivar, leído).
 *
 * 09: con `viewer`, el predicado de visibilidad va DENTRO del WHERE del
 * UPDATE; 0 filas afectadas → null → la ruta responde 404 (no existe o no la
 * ves). Nada de leer y luego actualizar. Sin `viewer` (llamadores internos)
 * solo filtra por org + id, como antes.
 */
export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean },
  viewer?: Viewer
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.handoffNote = null;
    set.aiEnabled = patch.aiEnabled ?? true;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        viewer ? conversationVisibleTo(viewer) : undefined
      )
    )
    .returning();
  return updated[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * 09 — Asignación (RF-09-04..07). Toda escritura es un UPDATE
 * condicional con RETURNING: la precondición vive en el WHERE, nunca en
 * un "leer y luego actualizar".
 * ------------------------------------------------------------------ */

/**
 * Predicado de `claimForSend`: no es de prueba y está sin asignar o ya es de
 * `userId`. Exportado para el unit que fija su forma.
 */
export function claimCondition(
  organizationId: string,
  conversationId: string,
  userId: string
): SQL {
  const c = schema.conversation;
  return scoped(
    c.organizationId,
    organizationId,
    eq(c.id, conversationId),
    eq(c.isTest, false),
    or(isNull(c.assignedUserId), eq(c.assignedUserId, userId))
  );
}

/**
 * Compuerta de envío del Vendedor ("responder = tomar", RF-09-07): asigna la
 * conversación a `userId` si está sin asignar, o confirma que ya es suya, en
 * UNA sentencia atómica. `false` = otro la tomó (o no existe / es `is_test`):
 * la ruta responde 404 y NO llama al sender. Idempotente si ya era suya
 * (`assigned_at` se conserva).
 *
 * Solo para rutas de sesión con rol Vendedor: el Propietario no se
 * auto-asigna (D-09-3) y los caminos sin sesión (agente in-process, ingest,
 * `/api/bot/*`) no pasan por aquí.
 */
export async function claimForSend(
  organizationId: string,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const c = schema.conversation;
  const rows = await getDb()
    .update(c)
    .set({
      assignedUserId: userId,
      assignedAt: sql`coalesce(${c.assignedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(claimCondition(organizationId, conversationId, userId))
    .returning({ id: c.id });
  return rows.length > 0;
}

/**
 * Compuerta de envío de una ruta de sesión: Propietario → pasa sin tocar
 * nada (D-09-3); Vendedor → `claimForSend`. Si el Vendedor acaba de tomar una
 * conversación que estaba sin asignar (según la lectura previa de la ruta),
 * avisa por SSE para que los demás vendedores refresquen su lista: ellos ya no
 * recibirán el `message.new` de una conversación que dejaron de ver.
 */
export async function gateSend(
  session: Viewer & { organizationId: string },
  conversationId: string,
  previousAssigneeId: string | null
): Promise<boolean> {
  if (isOwner(session)) return true;
  const claimed = await claimForSend(
    session.organizationId,
    conversationId,
    session.userId
  );
  if (claimed && previousAssigneeId === null) {
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: conversationId } },
    });
  }
  return claimed;
}

export type AssignResult =
  /** `changed: false` = ya estaba así (idempotente: sin evento). */
  | { kind: "ok"; changed: boolean }
  | { kind: "not_found" }
  /** Otro la tiene (carrera de "tomar"); `assignee` = responsable actual. */
  | { kind: "conflict"; assignee: Assignee }
  | { kind: "invalid_assignee" };

/**
 * Asigna (`to` = user id), reasigna o libera (`to = null`) — RF-09-04..06.
 *
 * UN UPDATE condicional cuyo WHERE lleva: tenant + id, `is_test = false`
 * (nunca se asignan), la visibilidad del `viewer` si se pasa (Vendedor: suya o
 * sin asignar), `expect: "unassigned"` (sin asignar o ya de `to`), que `to`
 * sea miembro de la org (EXISTS sobre `member`) y que de verdad cambie algo.
 * 1 fila → `{ ok, changed: true }` (quien llama publica tras el commit).
 *
 * 0 filas → una lectura SOLO para clasificar el error (404/422/409) o el
 * no-op idempotente. Esa lectura nunca decide escribir: la escritura ya
 * ocurrió o no en el UPDATE — no es check-then-update.
 *
 * Las reglas por rol (el Vendedor solo se toma a sí mismo o libera) las aplica
 * la ruta antes de llamar; aquí `viewer` aporta su visibilidad.
 */
export async function assignConversation(
  organizationId: string,
  conversationId: string,
  opts: { to: string | null; expect?: "unassigned" },
  viewer?: Viewer
): Promise<AssignResult> {
  const { to, expect } = opts;
  const c = schema.conversation;
  const m = schema.member;
  const db = getDb();

  const updated = await db
    .update(c)
    .set({
      assignedUserId: to,
      assignedAt: to ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.id, conversationId),
        eq(c.isTest, false),
        viewer ? conversationVisibleTo(viewer) : undefined,
        expect === "unassigned" && to
          ? or(isNull(c.assignedUserId), eq(c.assignedUserId, to))
          : undefined,
        to
          ? exists(
              db
                .select({ one: sql`1` })
                .from(m)
                .where(scoped(m.organizationId, organizationId, eq(m.userId, to)))
            )
          : undefined,
        // Solo si cambia: repetir la misma operación es un no-op sin evento.
        to
          ? or(isNull(c.assignedUserId), ne(c.assignedUserId, to))
          : isNotNull(c.assignedUserId)
      )
    )
    .returning({ id: c.id });
  if (updated.length > 0) return { kind: "ok", changed: true };

  // Clasificación del 0 filas (solo lectura; ver arriba).
  const rows = await db
    .select({
      isTest: c.isTest,
      assignedUserId: c.assignedUserId,
      assigneeName: schema.user.name,
    })
    .from(c)
    .leftJoin(schema.user, eq(schema.user.id, c.assignedUserId))
    .where(scoped(c.organizationId, organizationId, eq(c.id, conversationId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.isTest) return { kind: "not_found" };

  if (to) {
    const member = await db
      .select({ id: m.id })
      .from(m)
      .where(scoped(m.organizationId, organizationId, eq(m.userId, to)))
      .limit(1);
    if (member.length === 0) return { kind: "invalid_assignee" };
  }

  const current = row.assignedUserId;
  const visible =
    !viewer || isOwner(viewer) || current === null || current === viewer.userId;
  if (current === to && visible) return { kind: "ok", changed: false };

  const assignee: Assignee = current
    ? { userId: current, name: row.assigneeName ?? "" }
    : null;
  // "Tomar" (con expect, o el Vendedor asignándose) que perdió la carrera.
  if (to && (expect === "unassigned" || (viewer && !isOwner(viewer)))) {
    return { kind: "conflict", assignee };
  }
  // Vendedor liberando una ajena: no la ve → 404 (no revela existencia).
  if (!visible) return { kind: "not_found" };
  // El estado cambió entre el UPDATE y la lectura (escritura concurrente).
  return { kind: "conflict", assignee };
}
