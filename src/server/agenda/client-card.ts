import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { tipoDeOrigen } from "@/lib/anuncios";
import { isOwner } from "@/lib/roles";
import type { Channel } from "@/lib/channels";
import type { AnuncioDto, PriorityValue, SourceDto } from "@/lib/types";
import { getVisibleBooking, type BookingViewer } from "@/server/agenda/queries";
import { anuncioDelContacto } from "@/server/attribution/store";
import {
  getContactById,
  getContactStage,
  serializeContact,
} from "@/server/contacts";
import { canSeeConversation } from "@/server/inbox/visibility";

/**
 * 029 (US-3) — El cliente de una cita: quién es, cómo escribirle y de dónde
 * vino, pedido al ABRIR la cita (no engorda `GET /api/bookings`).
 *
 * Regla de la decisión 4 del dueño:
 *   completo = Propietario ∨ cita sin asignar ∨ cita asignada a mí ∨ veo el chat
 * Si no aplica (cita asignada a otro Vendedor y chat ajeno) solo viajan nombre
 * y teléfono: canal, etapa, prioridad, fuente y anuncio se OMITEN aquí, en el
 * servidor. El botón «Abrir conversación» depende solo de ver el chat (la
 * Bandeja no lo abriría de otro modo).
 */

export type BookingClientConversation = {
  id: string;
  /** Responsable del chat; null = sin asignar. */
  assignedUserName: string | null;
  /** ¿La Bandeja se lo abriría a quien pregunta? */
  canOpenChat: boolean;
};

export type BookingClientCard = {
  contactId: string;
  name: string;
  /** null = sin teléfono (identidad `bsuid:`, Instagram, Messenger). */
  phone: string | null;
  /** true ⇒ solo nombre y teléfono (los demás campos no viajan). */
  restricted: boolean;
  /** La de la cita o, si no tiene, la más reciente (no de prueba) del contacto. */
  conversation: BookingClientConversation | null;
  channel?: Channel;
  stageName?: string | null;
  priority?: PriorityValue | null;
  source?: SourceDto;
  anuncio?: AnuncioDto | null;
};

/** Respuesta de `GET /api/bookings/[id]/client`. `card: null` en bloqueos. */
export type BookingClientResponse = { card: BookingClientCard | null };

/**
 * PURA — ¿Datos completos o solo nombre + teléfono? `canSeeChat` es la
 * visibilidad de la conversación de la cita (false si no hay conversación).
 */
export function isClientRestricted(
  viewer: BookingViewer,
  booking: { assignedUserId: string | null },
  canSeeChat: boolean
): boolean {
  if (isOwner(viewer)) return false;
  if (booking.assignedUserId === null) return false;
  if (booking.assignedUserId === viewer.userId) return false;
  return !canSeeChat;
}

type ConversationRow = {
  id: string;
  channel: Channel;
  assignedUserName: string | null;
};

/**
 * La conversación de la cita: la suya si la tiene; si no, la más reciente del
 * contacto que no sea del Laboratorio. Una sola consulta con el nombre del
 * responsable.
 */
async function resolveConversation(
  organizationId: string,
  booking: { conversationId: string | null; contactId: string }
): Promise<ConversationRow | null> {
  const c = schema.conversation;
  const rows = await getDb()
    .select({ id: c.id, channel: c.channel, assignedUserName: schema.user.name })
    .from(c)
    .leftJoin(schema.user, eq(c.assignedUserId, schema.user.id))
    .where(
      booking.conversationId
        ? scoped(c.organizationId, organizationId, eq(c.id, booking.conversationId))
        : scoped(
            c.organizationId,
            organizationId,
            eq(c.contactId, booking.contactId),
            eq(c.isTest, false)
          )
    )
    .orderBy(desc(sql`coalesce(${c.lastMessageAt}, ${c.createdAt})`))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `null` ⇒ la cita no existe, es de otra organización o no le toca a quien
 * pregunta (la ruta responde 404 en los tres casos, como el resto de la
 * agenda). `{ card: null }` ⇒ es un bloqueo (o su contacto ya no existe).
 */
export async function getBookingClientCard(
  organizationId: string,
  viewer: BookingViewer,
  bookingId: string
): Promise<BookingClientResponse | null> {
  const booking = await getVisibleBooking(organizationId, bookingId, viewer);
  if (!booking) return null;
  if (booking.kind === "block" || !booking.contactId) return { card: null };
  const contactId = booking.contactId;

  const contact = await getContactById(organizationId, contactId);
  if (!contact) return { card: null };

  const conv = await resolveConversation(organizationId, {
    conversationId: booking.conversationId,
    contactId,
  });
  const canOpenChat = conv
    ? await canSeeConversation(organizationId, viewer, conv.id)
    : false;
  const restricted = isClientRestricted(viewer, booking, canOpenChat);

  const card: BookingClientCard = {
    contactId,
    name: contact.name,
    phone: contact.phone ?? null,
    restricted,
    conversation: conv
      ? { id: conv.id, assignedUserName: conv.assignedUserName ?? null, canOpenChat }
      : null,
  };
  if (restricted) return { card };

  const [stageRow, anuncio] = await Promise.all([
    getContactStage(organizationId, contactId),
    anuncioDelContacto(organizationId, contactId),
  ]);
  // La misma serialización que Contactos (fuente deducida incluida); de ella
  // solo se toman los chips: notas y ficha no son de esta tarjeta.
  const dto = serializeContact(
    contact,
    stageRow?.stage.name ?? null,
    stageRow?.lead.priority ?? null,
    tipoDeOrigen(anuncio)
  );
  return {
    card: {
      ...card,
      channel: conv?.channel ?? dto.channel,
      stageName: dto.stageName,
      priority: dto.priority,
      source: dto.source,
      anuncio,
    },
  };
}
