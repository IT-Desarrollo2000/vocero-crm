import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  NOTIFICATION_LIST_LIMIT,
  bookingAssignedKey,
  chatAssignedKey,
  safeErrorTag,
  type NotificationDto,
  type NotificationKind,
  type NotificationListDto,
  type NotificationPayload,
  type NotificationReadBody,
} from "@/lib/notifications";
import { publish } from "@/server/events/bus";
import { reportTimezone } from "@/server/reports/timezone";
import { countFollowUps } from "@/server/follow-ups/counts";

/**
 * 035 fase B — La ÚNICA puerta que escribe `notification`.
 *
 * - Crear es idempotente: `ON CONFLICT DO NOTHING` sobre
 *   `(organization_id, user_id, dedupe_key)` y solo los que de verdad
 *   entraron se publican por SSE (`notification.changed` → solo a su
 *   destinatario, ver `canReceive`).
 * - Avisar nunca tumba la operación que lo provoca: `notifySafe` atrapa y
 *   registra sin datos personales (ni nombres ni notas).
 * - Todo va DESPUÉS del commit de la operación principal.
 */

const N = schema.notification;
// Perezoso: hay pruebas que sustituyen `schema` por un objeto parcial y un
// alias a nivel de módulo reventaría al importar.
let actorAlias: ReturnType<typeof makeActor> | null = null;
function makeActor() {
  return alias(schema.user, "notification_actor");
}

export type NewNotification = {
  organizationId: string;
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  followUpId?: string | null;
  conversationId?: string | null;
  bookingId?: string | null;
  contactId?: string | null;
  actorUserId?: string | null;
  payload: NotificationPayload;
};

function baseSelect() {
  const actor = (actorAlias ??= makeActor());
  return getDb()
    .select({
      n: N,
      contactName: schema.contact.name,
      actorName: actor.name,
      fuStatus: schema.followUp.status,
      fuDueAt: schema.followUp.dueAt,
      chatId: schema.conversation.id,
    })
    .from(N)
    .leftJoin(schema.contact, eq(schema.contact.id, N.contactId))
    .leftJoin(actor, eq(actor.id, N.actorUserId))
    .leftJoin(schema.followUp, eq(schema.followUp.id, N.followUpId))
    // El chat real del contacto HOY (como en Pendientes): un recordatorio
    // creado desde Contactos encuentra su chat si nace después.
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, N.contactId),
        eq(schema.conversation.organizationId, N.organizationId),
        eq(schema.conversation.isTest, false)
      )
    );
}

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["where"]>>[number];

function toDto(r: Row): NotificationDto {
  const n = r.n;
  const name = r.contactName ?? n.payload?.contactName ?? null;
  return {
    id: n.id,
    kind: n.kind,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
    contact: n.contactId && name ? { id: n.contactId, name } : null,
    conversationId: n.conversationId ?? r.chatId ?? null,
    bookingId: n.bookingId,
    followUpId: n.followUpId,
    actorName: r.actorName ?? null,
    payload: n.payload ?? {},
    followUp:
      n.kind === "follow_up_due" && r.fuStatus && r.fuDueAt
        ? { status: r.fuStatus, dueAt: r.fuDueAt.toISOString(), conversationId: r.chatId ?? null }
        : null,
  };
}

/** Sin repetidos (un contacto con chat en dos canales sale dos veces). */
function uniqueDtos(rows: Row[]): NotificationDto[] {
  const seen = new Set<string>();
  const out: NotificationDto[] = [];
  for (const r of rows) {
    if (seen.has(r.n.id)) continue;
    seen.add(r.n.id);
    out.push(toDto(r));
  }
  return out;
}

async function byIds(organizationId: string, ids: string[]): Promise<NotificationDto[]> {
  if (ids.length === 0) return [];
  const rows = await baseSelect().where(scoped(N.organizationId, organizationId, inArray(N.id, ids)));
  return uniqueDtos(rows);
}

/**
 * Inserta los avisos (de UNA organización) que aún no existen y publica los
 * nuevos. Devuelve cuántos entraron.
 */
export async function createNotifications(rows: NewNotification[]): Promise<number> {
  if (rows.length === 0) return 0;
  const organizationId = rows[0]!.organizationId;
  const inserted = await getDb()
    .insert(N)
    .values(
      rows.map((r) => ({
        id: newId("notification"),
        organizationId,
        userId: r.userId,
        kind: r.kind,
        dedupeKey: r.dedupeKey,
        followUpId: r.followUpId ?? null,
        conversationId: r.conversationId ?? null,
        bookingId: r.bookingId ?? null,
        contactId: r.contactId ?? null,
        actorUserId: r.actorUserId ?? null,
        payload: r.payload,
      }))
    )
    .onConflictDoNothing({ target: [N.organizationId, N.userId, N.dedupeKey] })
    .returning({ id: N.id, userId: N.userId });
  if (inserted.length === 0) return 0;
  const dtos = await byIds(
    organizationId,
    inserted.map((r) => r.id)
  );
  const userOf = new Map(inserted.map((r) => [r.id, r.userId]));
  for (const dto of dtos) {
    publish(organizationId, {
      type: "notification.changed",
      data: { userId: userOf.get(dto.id)!, reason: "new", notification: dto },
    });
  }
  return inserted.length;
}

/** Envuelve un aviso: si falla, se registra (sin datos personales) y sigue. */
export async function notifySafe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[avisos] no se pudo crear el aviso (${label}): ${safeErrorTag(err)}`);
  }
}

/** La campana: los últimos 30 propios, no leídos y el resumen en vivo. */
export async function listNotifications(
  organizationId: string,
  userId: string,
  now: Date = new Date()
): Promise<NotificationListDto> {
  const tz = await reportTimezone(organizationId);
  const [rows, unreadRows, summary] = await Promise.all([
    baseSelect()
      .where(scoped(N.organizationId, organizationId, eq(N.userId, userId)))
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(NOTIFICATION_LIST_LIMIT * 2),
    getDb()
      .select({ n: count() })
      .from(N)
      .where(scoped(N.organizationId, organizationId, eq(N.userId, userId), isNull(N.readAt))),
    countFollowUps(organizationId, userId, now, tz),
  ]);
  return {
    notifications: uniqueDtos(rows).slice(0, NOTIFICATION_LIST_LIMIT),
    unread: unreadRows[0]?.n ?? 0,
    summary,
    businessTimezone: tz,
  };
}

/** Marca leídos los propios (`ids` o todos). Devuelve cuántos cambiaron. */
export async function markNotificationsRead(
  organizationId: string,
  userId: string,
  body: NotificationReadBody,
  now: Date = new Date()
): Promise<number> {
  const all = "all" in body;
  const updated = await getDb()
    .update(N)
    .set({ readAt: now })
    .where(
      scoped(
        N.organizationId,
        organizationId,
        eq(N.userId, userId),
        isNull(N.readAt),
        all ? undefined : inArray(N.id, body.ids)
      )
    )
    .returning({ id: N.id });
  if (updated.length > 0) {
    publish(organizationId, {
      type: "notification.changed",
      data: all
        ? { userId, reason: "read", all: true }
        : { userId, reason: "read", ids: updated.map((r) => r.id) },
    });
  }
  return updated.length;
}

/**
 * Hecho / posponer: el aviso de vencido de ese recordatorio (de quien sea su
 * dueño, aunque lo toque el Propietario) queda leído.
 */
export async function markFollowUpNoticesRead(
  organizationId: string,
  followUpId: string,
  now: Date = new Date()
): Promise<void> {
  const updated = await getDb()
    .update(N)
    .set({ readAt: now })
    .where(
      scoped(
        N.organizationId,
        organizationId,
        eq(N.followUpId, followUpId),
        eq(N.kind, "follow_up_due"),
        isNull(N.readAt)
      )
    )
    .returning({ id: N.id, userId: N.userId });
  const byUser = new Map<string, string[]>();
  for (const r of updated) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.id]);
  for (const [userId, ids] of byUser) {
    publish(organizationId, { type: "notification.changed", data: { userId, reason: "read", ids } });
  }
}

/** Retención: borra los leídos de antes de `before` (una organización). */
export async function purgeReadNotifications(organizationId: string, before: Date): Promise<number> {
  const gone = await getDb()
    .delete(N)
    .where(scoped(N.organizationId, organizationId, lt(N.readAt, before)))
    .returning({ id: N.id });
  return gone.length;
}

// ── Productores (llamados después del commit, siempre vía `notifySafe`) ──

/** «Te asignaron a …»: alguien (≠ destinatario) le pasó el chat. */
export async function notifyChatAssigned(input: {
  organizationId: string;
  conversationId: string;
  toUserId: string;
  actorUserId: string;
  assignedAt: Date;
  contact: { id: string; name: string };
}): Promise<void> {
  if (input.toUserId === input.actorUserId) return;
  await createNotifications([
    {
      organizationId: input.organizationId,
      userId: input.toUserId,
      kind: "chat_assigned",
      dedupeKey: chatAssignedKey(input.conversationId, input.toUserId, input.assignedAt),
      conversationId: input.conversationId,
      contactId: input.contact.id,
      actorUserId: input.actorUserId,
      payload: { contactName: input.contact.name },
    },
  ]);
}

type BookingLike = {
  id: string;
  kind: string;
  isTest: boolean;
  contactId: string | null;
  conversationId: string | null;
  scheduledAt: Date;
  updatedAt: Date;
};

/**
 * «Te asignaron la cita de …» (o «Se agendó…» si la agendó la IA/bot, sin
 * actor). Nunca de citas de prueba ni de bloqueos; nunca a quien la movió.
 */
export async function notifyBookingAssigned(input: {
  organizationId: string;
  booking: BookingLike;
  toUserId: string | null;
  actorUserId: string | null;
  contactName?: string | null;
}): Promise<void> {
  const { booking, toUserId } = input;
  if (!toUserId || booking.isTest || booking.kind !== "session") return;
  if (input.actorUserId && toUserId === input.actorUserId) return;
  let name = input.contactName ?? null;
  if (!name && booking.contactId) {
    const [c] = await getDb()
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(scoped(schema.contact.organizationId, input.organizationId, eq(schema.contact.id, booking.contactId)))
      .limit(1);
    name = c?.name ?? null;
  }
  await createNotifications([
    {
      organizationId: input.organizationId,
      userId: toUserId,
      kind: "booking_assigned",
      dedupeKey: bookingAssignedKey(booking.id, toUserId, booking.updatedAt),
      bookingId: booking.id,
      contactId: booking.contactId,
      conversationId: booking.conversationId,
      actorUserId: input.actorUserId,
      payload: {
        ...(name ? { contactName: name } : {}),
        scheduledAt: booking.scheduledAt.toISOString(),
        ...(input.actorUserId ? {} : { byAgent: true }),
      },
    },
  ]);
}
