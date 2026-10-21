import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { resolveFichaKey, type FichaFieldDef } from "@/lib/ficha-fields";
import {
  LEAD_INTAKE_TYPE,
  LEAD_INTAKE_WAMID_PREFIX,
} from "@/lib/lead-intake";
import type { SourceValue } from "@/lib/types";
import { upsertFicha } from "@/server/bot/ficha";
import { publish } from "@/server/events/bus";
import { getFichaFields } from "@/server/ficha-fields";
import { UNARCHIVE_SET } from "@/server/inbox/archive";
import { openAwaitingSql } from "@/server/inbox/awaiting";
import {
  getOrCreateContactByIdentity,
  isFallbackName,
} from "@/server/inbox/identity";
import {
  getOrCreateConversation,
  serializeMessage,
} from "@/server/inbox/ingest";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import {
  buildLeadCardText,
  fullName,
  looksLikeEmail,
  type IntakeLead,
  type IntakeOrigin,
} from "./contract";
import { phoneLast4 } from "./phone";
import { recordIntakeReceived } from "./settings";

/**
 * 011 — Un lead del ERP entra a la Bandeja.
 *
 * Contacto (upsert por teléfono, RF-5) → conversación real del contacto o una
 * nueva SIN ASIGNAR (RF-6) → TARJETA como mensaje entrante `lead_intake`
 * (RF-7). La tarjeta va ANTES que lo demás a propósito: su
 * `wa_message_id = intake:<lead_id>` es UNIQUE, así que un `lead_id` repetido
 * (el cron de conciliación del ERP reenvía las últimas 48 h) se descubre ahí y
 * corta sin volver a tocar fuente, lead ni ficha (RF-11). La tarjeta y el
 * update de la Bandeja van en una sola transacción; fuente, lead, ficha y
 * «último recibido» son accesorios (`step`); los `publish`, tras el commit.
 *
 * Lo que NO hace, y es deliberado:
 * - no dispara el agente (`maybeRunAgentTurn`): con la ventana de 24 h
 *   cerrada escalaría por `ventana` — alerta engañosa y escalación falsa en
 *   las métricas (RF-10);
 * - no toca `lastInboundAt`: la ventana sigue cerrada y el compositor obliga
 *   a plantilla (`replyModeFor`), que es justo lo correcto para el primer
 *   contacto.
 */

/** De qué fuente queda el contacto si nadie la había capturado (D-11-5). */
export const SOURCE_FOR_ORIGIN: Record<IntakeOrigin, SourceValue> = {
  website: "web",
  fast_app: "promotor",
};

export type IngestExternalLeadResult = {
  contactId: string;
  conversationId: string;
  /** ¿El contacto es nuevo? */
  created: boolean;
  /** Mismo `lead_id` ya entregado: sin efectos. */
  duplicate: boolean;
};

/**
 * Claves de la ficha a las que va cada dato (RF-9). El correo va siempre (a
 * la clave que el negocio tenga para él o a `email`, contrato de claves libres
 * como el del cerebro externo); vehículo y sucursal solo si el negocio definió
 * un campo para ellos — si no, se quedan en la tarjeta.
 */
export function fichaPatchFor(
  lead: IntakeLead,
  fields: readonly FichaFieldDef[] | null | undefined
): Record<string, string> {
  const defs = fields ?? [];
  const pick = (candidates: string[]) => {
    for (const c of candidates) {
      const def = resolveFichaKey(c, defs);
      if (def && def.type === "texto") return def.key;
    }
    return null;
  };
  const patch: Record<string, string> = {};
  if (looksLikeEmail(lead.email)) {
    patch[pick(["email", "correo"]) ?? "email"] = lead.email;
  }
  const vehicleKey = lead.vehicle
    ? pick(["vehiculo", "modelo_interes", "modelo"])
    : null;
  if (vehicleKey && lead.vehicle) patch[vehicleKey] = lead.vehicle;
  const branchKey = lead.branch ? pick(["sucursal"]) : null;
  if (branchKey && lead.branch) patch[branchKey] = lead.branch;
  return patch;
}

export async function ingestExternalLead(
  organizationId: string,
  lead: IntakeLead,
  phone: string
): Promise<IngestExternalLeadResult> {
  const db = getDb();
  const tag = `[011] lead ${lead.lead_id} (${lead.origin}) ··${phoneLast4(phone)}`;

  // 022: `profile_name` es el nombre de perfil del CANAL (el nickname de
  // WhatsApp) y el formulario no lo es: va null, o pisaría el nick real del
  // contacto y la línea «WhatsApp: «…»» mentiría. El nombre del lead va a
  // `name`, y solo si sigue siendo el de respaldo (contacto nuevo → su
  // teléfono): nunca sobre un nombre que alguien escribió. Antes de la
  // tarjeta: si falla, el reintento del ERP no cae en `duplicate`.
  const { contact, isNew } = await getOrCreateContactByIdentity(
    organizationId,
    {
      identity: phone,
      phone,
      waUserId: null,
      profileName: null,
    }
  );
  const leadName = fullName(lead);
  if (leadName && leadName !== contact.name && isFallbackName(contact)) {
    const patch = { name: leadName, updatedAt: new Date() };
    await db
      .update(schema.contact)
      .set(patch)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.id, contact.id)
        )
      );
    Object.assign(contact, patch);
  }
  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: contact.channel }
  );

  const now = new Date();
  // La tarjeta y la Bandeja (no leídos, orden, desarchivo) van en UNA
  // transacción: si el update falla, la tarjeta se revierte y el endpoint da
  // 500, así el reintento del ERP vuelve a entrar en vez de caer en
  // `duplicate` con la conversación sin subir ni avisar.
  const message = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.message)
      .values({
        id: newId("message"),
        organizationId,
        conversationId: conversation.id,
        waMessageId: `${LEAD_INTAKE_WAMID_PREFIX}${lead.lead_id}`,
        direction: "in",
        type: LEAD_INTAKE_TYPE,
        text: buildLeadCardText(lead),
        status: "delivered",
        // La hora en que el prospecto dejó sus datos (si el ERP la manda).
        waTimestamp: lead.created_at ?? now,
      })
      .onConflictDoNothing({ target: [schema.message.waMessageId] })
      .returning();
    const row = inserted[0];
    if (!row) return null; // duplicado: nada que subir ni desarchivar

    // Sube no leídos y la sube en la lista; `greatest` para que un lead viejo
    // (carga inicial, conciliación) no entierre una conversación más
    // reciente. 022: la tarjeta es un entrante → desarchiva, como el de
    // WhatsApp (tras el dedupe: un `lead_id` repetido no desarchiva).
    await tx
      .update(schema.conversation)
      .set({
        lastMessageAt: sql`greatest(${schema.conversation.lastMessageAt}, ${now.toISOString()}::timestamp)`,
        unreadCount: sql`${schema.conversation.unreadCount} + 1`,
        // 026: el prospecto espera respuesta desde que entra al CRM (no desde
        // la fecha del lead: la carga inicial no debe nacer "atrasada").
        awaitingSince: openAwaitingSql(now),
        updatedAt: now,
        ...UNARCHIVE_SET,
      })
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, conversation.id)
        )
      );
    return row;
  });
  if (!message) {
    console.info(`${tag}: duplicado, sin efectos`);
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      created: false,
      duplicate: true,
    };
  }

  // Lo que sigue es accesorio a la tarjeta: si algo falla, el lead YA está
  // en la Bandeja y un reintento del ERP sería duplicado — así que se anota
  // y se sigue, en vez de devolver 500. Al log va solo el mensaje del error:
  // el objeto completo podría arrastrar el payload (correo, notas).
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(
        `${tag}: falló «${name}»:`,
        err instanceof Error ? err.message : "desconocido"
      );
    }
  };

  await step("fuente", async () => {
    if (contact.source) return; // lo capturado manda (D-11-5)
    await db
      .update(schema.contact)
      .set({ source: SOURCE_FOR_ORIGIN[lead.origin], updatedAt: now })
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.id, contact.id),
          sql`${schema.contact.source} is null`
        )
      );
  });

  await step("lead", () =>
    createLeadForContact({ organizationId, contactId: contact.id, at: now })
  );

  await step("ficha", async () => {
    const fields = await getFichaFields(organizationId);
    const patch = fichaPatchFor(lead, fields);
    if (Object.keys(patch).length === 0) return;
    await upsertFicha({
      organizationId,
      contactId: contact.id,
      ficha: patch,
      source: "externo",
      conversationId: conversation.id,
      fields,
    });
  });

  await step("último recibido", () =>
    recordIntakeReceived(organizationId, lead.origin, now)
  );

  // `message.new` entrante → globo y alerta (05) sin plomería nueva.
  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });

  console.info(`${tag}: aceptado → ${conversation.id}`);
  return {
    contactId: contact.id,
    conversationId: conversation.id,
    created: isNew,
    duplicate: false,
  };
}
