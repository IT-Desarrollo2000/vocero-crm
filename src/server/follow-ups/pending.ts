import { and, asc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { matchTemplateByText } from "@/lib/template-sent";
import { addDaysISO, zonedWallClockToUtc } from "@/lib/time/slots";
import {
  PENDING_ROW_CAP,
  type NoReplyRowDto,
  type PendingDto,
  type PendingQuery,
  type PendingRowDto,
} from "@/lib/follow-ups";
import { reportTimezone } from "@/server/reports/timezone";
import { scopeUserId, type FollowUpViewer } from "./store";

/**
 * 035 — Los dos recuadros que se arman solos en Pendientes.
 *
 * Conjunto base: las conversaciones REALES (`is_test = false`), no archivadas
 * (ni la conversación ni el contacto), del vendedor (`assigned_user_id`). El
 * Propietario con «Todos» ve todas, también las sin asignar: en un negocio de
 * una sola persona nadie asigna y el recuadro saldría vacío.
 *
 * «Sin contacto» usa `conversation.last_message_at`: lo mantienen la ingesta,
 * el envío, las plantillas, el eco del teléfono, la IA y los leads externos,
 * así que es «el último mensaje de cualquier lado» sin agregar `message`
 * (una fila por chat, índice `conversation_org_last_idx`). Un envío que falló
 * también lo mueve: cuenta como intento de contacto.
 *
 * «Sin respuesta a tu plantilla» acota primero por ese mismo campo y solo
 * entonces busca el último mensaje de cada chat (top-1 por
 * `message_org_conv_idx`). Dos consultas por pantalla, sin N+1.
 */

const C = schema.conversation;
const M = schema.message;

/** `coalesce(last_message_at, created_at)`: un chat sin mensajes cuenta desde que nació. */
const lastAtSql = sql<Date>`coalesce(${C.lastMessageAt}, ${C.createdAt})`.mapWith(C.createdAt);

function pgTs(d: Date): SQL {
  return sql`${d.toISOString().replace("T", " ").replace("Z", "")}::timestamp`;
}

/** Recordatorio abierto más próximo del contacto, del alcance que se mira. */
function openFollowUpSql(organizationId: string, userId: string | null) {
  return sql<Date | null>`(
    select min(fu.due_at) from ${schema.followUp} fu
    where fu.organization_id = ${organizationId}
      and fu.contact_id = ${C.contactId}
      and fu.status = 'open'
      ${userId ? sql`and fu.user_id = ${userId}` : sql``}
  )`.mapWith(schema.followUp.dueAt);
}

function baseConditions(organizationId: string, userId: string | null): SQL {
  return scoped(
    C.organizationId,
    organizationId,
    eq(C.isTest, false),
    isNull(C.archivedAt),
    isNull(schema.contact.archivedAt),
    userId ? eq(C.assignedUserId, userId) : undefined
  );
}

function rowOf(r: {
  conversationId: string;
  contactId: string;
  contactName: string;
  stageName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  lastAt: Date;
  openFollowUpAt: Date | null;
}): PendingRowDto {
  return {
    conversationId: r.conversationId,
    contact: { id: r.contactId, name: r.contactName },
    stageName: r.stageName,
    assignedTo: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? "" } : null,
    lastAt: r.lastAt.toISOString(),
    openFollowUpAt: r.openFollowUpAt ? r.openFollowUpAt.toISOString() : null,
  };
}

/** Límites del rango «Entre fechas» (días de pared de la zona del negocio). */
export function betweenBounds(from: string, to: string, tz: string): { start: Date; end: Date } | null {
  const start = zonedWallClockToUtc(from, "00:00", tz);
  const end = zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz);
  return start && end ? { start, end } : null;
}

export async function pendingFor(
  organizationId: string,
  viewer: FollowUpViewer,
  q: PendingQuery,
  now: Date = new Date()
): Promise<PendingDto> {
  const db = getDb();
  const userId = scopeUserId(viewer, q.userId);
  const tz = await reportTimezone(organizationId);

  // ── Sin contacto ──
  let window: SQL;
  const between = q.from && q.to ? betweenBounds(q.from, q.to, tz) : null;
  if (between) {
    window = sql`${lastAtSql} >= ${pgTs(between.start)} and ${lastAtSql} < ${pgTs(between.end)}`;
  } else {
    const days = q.days ?? 30;
    window = sql`${lastAtSql} < ${pgTs(new Date(now.getTime() - days * 86_400_000))}`;
  }
  const notLost = q.includeLost
    ? undefined
    : sql`(${schema.pipelineStage.kind} is null or ${schema.pipelineStage.kind} <> 'lost')`;

  const noContactRows = await db
    .select({
      conversationId: C.id,
      contactId: C.contactId,
      contactName: schema.contact.name,
      stageName: schema.pipelineStage.name,
      assigneeId: C.assignedUserId,
      assigneeName: schema.user.name,
      lastAt: lastAtSql,
      openFollowUpAt: openFollowUpSql(organizationId, userId),
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(C)
    .innerJoin(schema.contact, eq(schema.contact.id, C.contactId))
    .leftJoin(schema.lead, eq(schema.lead.contactId, C.contactId))
    .leftJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .leftJoin(schema.user, eq(schema.user.id, C.assignedUserId))
    .where(and(baseConditions(organizationId, userId), window, notLost))
    // El que lleva más tiempo, primero.
    .orderBy(asc(lastAtSql), asc(C.id))
    .limit(PENDING_ROW_CAP);

  // ── Sin respuesta a tu plantilla ──
  const replyDays = q.replyDays ?? 3;
  const since = new Date(now.getTime() - replyDays * 86_400_000);
  // El ÚLTIMO mensaje de cada chat candidato (subconsulta top-1 por índice).
  const lastMessageId = sql`(
    select m2.id from ${M} m2
    where m2.organization_id = ${organizationId} and m2.conversation_id = ${C.id}
    order by m2.created_at desc, m2.id desc
    limit 1
  )`;
  const noReplyRows = await db
    .select({
      conversationId: C.id,
      contactId: C.contactId,
      contactName: schema.contact.name,
      stageName: schema.pipelineStage.name,
      assigneeId: C.assignedUserId,
      assigneeName: schema.user.name,
      lastAt: M.createdAt,
      openFollowUpAt: openFollowUpSql(organizationId, userId),
      text: M.text,
      status: M.status,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(C)
    .innerJoin(schema.contact, eq(schema.contact.id, C.contactId))
    .innerJoin(M, sql`${M.id} = ${lastMessageId}`)
    .leftJoin(schema.lead, eq(schema.lead.contactId, C.contactId))
    .leftJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .leftJoin(schema.user, eq(schema.user.id, C.assignedUserId))
    .where(
      and(
        baseConditions(organizationId, userId),
        // Acota antes de buscar el último mensaje: si el chat se movió
        // después de `since`, su último mensaje no puede ser tan viejo.
        sql`${lastAtSql} < ${pgTs(since)}`,
        eq(M.direction, "out"),
        eq(M.origin, "template"),
        ne(M.status, "failed"),
        sql`${M.createdAt} < ${pgTs(since)}`
      )
    )
    .orderBy(asc(M.createdAt), asc(C.id))
    .limit(PENDING_ROW_CAP);

  const templates =
    noReplyRows.length > 0
      ? await db
          .select({ id: schema.template.id, name: schema.template.name, body: schema.template.body })
          .from(schema.template)
          .where(scoped(schema.template.organizationId, organizationId))
      : [];

  return {
    businessTimezone: tz,
    noContact: {
      total: noContactRows[0]?.total ?? 0,
      rows: noContactRows.map(rowOf),
    },
    noReply: {
      total: noReplyRows[0]?.total ?? 0,
      rows: noReplyRows.map(
        (r): NoReplyRowDto => ({
          ...rowOf(r),
          templateName: matchTemplateByText(r.text, templates)?.name ?? null,
          templateStatus: r.status === "failed" ? "sent" : r.status,
        })
      ),
    },
  };
}
