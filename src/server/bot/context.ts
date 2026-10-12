import type { schema } from "@/lib/db";
import { serializeFicha } from "@/server/bot/ficha";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { effectiveSource } from "@/server/contact-source";
import {
  recentNotesText,
  type ContactContext,
} from "@/server/ai/contact-context";

type Contact = typeof schema.contact.$inferSelect;
type Conversation = typeof schema.conversation.$inferSelect;
type Lead = typeof schema.lead.$inferSelect;
type Stage = typeof schema.pipelineStage.$inferSelect;

/**
 * Cuerpo de `GET /api/bot/context`. Puro a propósito: el contrato publicado
 * se prueba sin BD (`tests/unit/bot-context.test.ts`).
 *
 * Regla del contrato: solo se AGREGA. Hay cerebros externos en producción
 * leyendo estas claves; quitar o renombrar una los rompe en silencio.
 *
 * 03 agregó: `contact.source`/`createdAt`/`notes` (recortadas igual que en el
 * prompt), `lead.amountCents`/`currency`/`stageKind`, `attribution` (solo con
 * ATRIBUCION), `bookings` (solo con AGENDA), `recurrent`, `now` y
 * `agentContext.block` — el texto EXACTO que recibe el agente in-process.
 * Si el contexto no se pudo armar, `ctx`/`block` llegan null y las claves
 * previas salen igual.
 */
export function buildBotContextPayload(input: {
  contact: Contact;
  conversation: Conversation;
  lead: { lead: Lead; stage: Stage } | null;
  ctx: ContactContext | null;
  block: string | null;
}) {
  const { contact, conversation, lead, ctx, block } = input;
  return {
    contact: {
      id: contact.id,
      name: contact.name,
      /** Nombre neutro (014). Preferir este en clientes nuevos. */
      identity: contact.waIdentity,
      /** Alias heredado: sigue aqui para no romper bots ya desplegados. */
      waIdentity: contact.waIdentity,
      channel: contact.channel,
      phone: contact.phone,
      ficha: serializeFicha(contact),
      // 03 — aditivos
      source: effectiveSource(contact.source),
      createdAt: contact.createdAt.toISOString(),
      notes: recentNotesText(contact.notes),
    },
    conversation: {
      id: conversation.id,
      // Una sola verdad para el bot: si hay handoff, la IA está apagada
      // aunque el flag siga en true.
      aiEnabled: conversation.aiEnabled && !conversation.handoffAt,
      handoffAt: conversation.handoffAt?.toISOString() ?? null,
      windowOpen: isWindowOpen(conversation.lastInboundAt),
      windowRemainingMs: windowRemainingMs(conversation.lastInboundAt),
    },
    lead: lead
      ? {
          id: lead.lead.id,
          stageName: lead.stage.name,
          // 03 — aditivos
          stageKind: lead.stage.kind,
          amountCents: lead.lead.amountCents,
          currency: lead.lead.currency,
        }
      : null,
    // 03 — aditivos. `attribution`/`bookings` solo existen con su bandera.
    ...(ctx && ctx.attribution !== undefined
      ? { attribution: ctx.attribution }
      : {}),
    ...(ctx && ctx.bookings !== undefined
      ? {
          bookings: ctx.bookings
            ? {
                next: ctx.bookings.next
                  ? {
                      scheduledAt: ctx.bookings.next.scheduledAt.toISOString(),
                      durationMinutes: ctx.bookings.next.durationMinutes,
                      moreCount: ctx.bookings.next.moreCount,
                    }
                  : null,
                last: ctx.bookings.last
                  ? {
                      scheduledAt: ctx.bookings.last.scheduledAt.toISOString(),
                      status: ctx.bookings.last.status,
                    }
                  : null,
              }
            : null,
        }
      : {}),
    recurrent: ctx?.recurrent
      ? { since: ctx.recurrent.since.toISOString() }
      : null,
    now: ctx ? { iso: ctx.now.toISOString(), timezone: ctx.timezone } : null,
    agentContext: { block },
  };
}
