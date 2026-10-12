import { desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { capabilitiesFor, replyModeFor } from "@/server/channels/capabilities";
import { conversationVisibleTo, type Viewer } from "@/server/inbox/visibility";
import type { AssignedFilter, ConversationDto } from "@/lib/types";

export type ListConversationsOptions = {
  /** Catch-up: solo las actualizadas después de este instante. */
  since?: Date;
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
 */
export async function listConversations(
  organizationId: string,
  viewer: Viewer,
  opts: ListConversationsOptions = {}
): Promise<ConversationDto[]> {
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
    .orderBy(desc(sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`));

  return rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      r.preview,
      r.stageName,
      assigneeOf(r.conversation, r.assigneeName)
    )
  );
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
  assignee: Assignee = null
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
