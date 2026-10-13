import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { buildBotContextPayload } from "@/server/bot/context";
import {
  fichaRenderOptions,
  loadContactContext,
  renderContactContext,
  type ContactContext,
} from "@/server/ai/contact-context";
import { fichaFieldsOrNull } from "@/server/ficha-fields";

export const dynamic = "force-dynamic";

/**
 * Contexto conversacional para un cerebro externo (solo lectura).
 * GET /api/bot/context?identity=... | ?waIdentity=... | ?conversationId=...
 *
 * `identity` es el nombre neutro (hay contactos que no son de WhatsApp).
 * `waIdentity` se mantiene aceptado y presente en la respuesta porque es
 * contrato publicado: hay cerebros externos en produccion que dependen de el.
 * No tiene fecha de retiro.
 *
 * NO devuelve el historial de mensajes: el bot lleva su propia memoria de la
 * conversación. Lo que aquí sale es lo que solo el CRM sabe — quién es la
 * persona, si un humano tomó el control y si la ventana de 24 h sigue abierta.
 *
 * 03 — Además, el mismo contexto que recibe el agente in-process (notas,
 * monto, citas, anuncio, recurrente) y el bloque ya renderizado en
 * `agentContext.block`. Solo campos ADITIVOS: ver `server/bot/context.ts`.
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const waIdentity =
    url.searchParams.get("identity") ?? url.searchParams.get("waIdentity");
  const conversationId = url.searchParams.get("conversationId");
  if (!waIdentity && !conversationId) {
    return apiError(422, "invalid", "Falta identity (o waIdentity) o conversationId");
  }

  const db = getDb();

  let contact: typeof schema.contact.$inferSelect | undefined;
  let conversation: typeof schema.conversation.$inferSelect | undefined;

  if (conversationId) {
    const rows = await db
      .select({ conversation: schema.conversation, contact: schema.contact })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        eq(schema.conversation.contactId, schema.contact.id)
      )
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, conversationId)
        )
      )
      .limit(1);
    contact = rows[0]?.contact;
    conversation = rows[0]?.conversation;
  } else if (waIdentity) {
    const contacts = await db
      .select()
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.waIdentity, waIdentity)
        )
      )
      .limit(1);
    contact = contacts[0];
    if (contact) {
      // La conversación del Laboratorio jamás se resuelve por identidad: ese
      // camino es para el bot de producción, que nunca debe hablarle a un
      // cliente simulado.
      const convs = await db
        .select()
        .from(schema.conversation)
        .where(
          scoped(
            schema.conversation.organizationId,
            organizationId,
            eq(schema.conversation.contactId, contact.id),
            eq(schema.conversation.isTest, false)
          )
        )
        .limit(1);
      conversation = convs[0];
    }
  }

  if (!contact || !conversation) {
    return apiError(404, "not_found", "Conversación no encontrada");
  }

  const leadRows = await db
    .select({ lead: schema.lead, stage: schema.pipelineStage })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.lead.stageId, schema.pipelineStage.id)
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contact.id)
      )
    )
    .limit(1);

  // El contexto extendido jamás tumba la respuesta: sin él, las claves
  // previas salen igual y `agentContext.block` llega null.
  // 04 — La definición de campos viaja al bot y da forma al bloque igual que
  // al agente in-process (`fichaRenderOptions`): mismo texto en los dos.
  const fichaFields = await fichaFieldsOrNull(organizationId).catch((err) => {
    console.error(
      `[bot] definición de la ficha no disponible: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  });
  let ctx: ContactContext | null = null;
  let block: string | null = null;
  try {
    ctx = await loadContactContext({
      organizationId,
      conversation,
      now: new Date(),
    });
    block = renderContactContext(ctx, fichaRenderOptions(ctx, fichaFields));
  } catch (err) {
    console.error(
      `[bot] contexto extendido no disponible: ${err instanceof Error ? err.name : typeof err}`
    );
  }

  return Response.json(
    buildBotContextPayload({
      contact,
      conversation,
      lead: leadRows[0] ?? null,
      ctx,
      block,
      fichaFields,
    })
  );
}
