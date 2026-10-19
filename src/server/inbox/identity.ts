import { and, eq, or } from "drizzle-orm";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { normalizeMx } from "@/lib/meta/client";
import type { WebhookMessage, WebhookValue } from "@/server/inbox/webhook";

/**
 * Identidad resiliente de contacto (003).
 *
 * Meta está migrando la identidad de WhatsApp de teléfono a Business-Scoped
 * User IDs (BSUID): `wa_id`/`from` pasan a ser opcionales y aparecen
 * `from_user_id` (mensaje) y `user_id` (contacts[]). Este módulo resuelve la
 * identidad del remitente sin asumir teléfono, y reconcilia para que un mismo
 * humano no genere dos contactos.
 */

export const BSUID_PREFIX = "bsuid:";
/** 014: identidad de Instagram, analoga al BSUID de WhatsApp. */
export const IG_PREFIX = "ig:";
/** 017: identidad de Messenger (PSID, único por Página). */
export const FB_PREFIX = "fb:";

// El tipo vive en lib/ porque la interfaz tambien lo necesita; se reexporta
// aqui para no tocar a quien ya lo importaba de este modulo.
export type { Channel };

export type ResolvedIdentity = {
  /** Llave estable de resolución: teléfono normalizado o `bsuid:<id>`. */
  identity: string;
  /** 014: canal del contacto. Ausente = whatsapp (compatibilidad). */
  channel?: Channel;
  phone: string | null;
  waUserId: string | null;
  profileName: string | null;
};

/**
 * Extrae la identidad utilizable de un mensaje del webhook.
 * Devuelve null si el mensaje no trae NINGUNA identidad (se descarta con log,
 * jamás se revienta el webhook).
 */
export function resolveIdentity(
  msg: WebhookMessage,
  contacts: WebhookValue["contacts"]
): ResolvedIdentity | null {
  const waUserId =
    msg.from_user_id ??
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.user_id ??
    contacts?.find((c) => c.user_id != null)?.user_id ??
    null;

  const profileName =
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.profile
      ?.name ??
    (waUserId
      ? contacts?.find((c) => c.user_id === waUserId)?.profile?.name
      : undefined) ??
    null;

  if (msg.from) {
    const phone = normalizeMx(msg.from);
    return { identity: phone, phone, waUserId, profileName };
  }
  if (waUserId) {
    return {
      identity: `${BSUID_PREFIX}${waUserId}`,
      phone: null,
      waUserId,
      profileName,
    };
  }
  return null;
}

/**
 * Resuelve o crea el contacto para una identidad, reconciliando:
 * - Si llegan teléfono Y BSUID, encuentra al contacto por cualquiera de los
 *   dos y adquiere la señal que le faltaba (el `wa_identity` NO cambia:
 *   es estable de por vida).
 * - Reactiva contactos archivados (el nombre editado por el operador se
 *   respeta).
 */
export async function getOrCreateContactByIdentity(
  organizationId: string,
  resolved: ResolvedIdentity
) {
  const db = getDb();

  const channel: Channel = resolved.channel ?? "whatsapp";

  // 014/017: Instagram y Messenger no comparten espacio de identidades con
  // WhatsApp. La reconciliacion telefono<->BSUID es exclusiva de WhatsApp, asi
  // que en los demas canales la busqueda es directa por identidad.
  if (channel !== "whatsapp") {
    const found = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.channel, channel),
          eq(schema.contact.waIdentity, resolved.identity)
        )
      )
      .limit(1);
    const existingOther = found[0];
    if (existingOther) {
      const patch = contactProfilePatch(existingOther, resolved.profileName);
      if (existingOther.archivedAt) patch.archivedAt = null;
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await db
          .update(schema.contact)
          .set(patch)
          .where(eq(schema.contact.id, existingOther.id));
        Object.assign(existingOther, patch);
      }
      return { contact: existingOther, isNew: false };
    }
    const createdOther = await db
      .insert(schema.contact)
      .values({
        id: newId("contact"),
        organizationId,
        channel,
        waIdentity: resolved.identity,
        phone: null,
        waUserId: null,
        name:
          resolved.profileName?.trim() || `Contacto de ${CHANNEL_LABEL[channel]}`,
        profileName: resolved.profileName?.trim() || null,
      })
      .onConflictDoNothing({
        target: [
          schema.contact.organizationId,
          schema.contact.channel,
          schema.contact.waIdentity,
        ],
      })
      .returning();
    if (createdOther[0]) return { contact: createdOther[0], isNew: true };
    const racedOther = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.channel, channel),
          eq(schema.contact.waIdentity, resolved.identity)
        )
      )
      .limit(1);
    const contactOther = racedOther[0];
    if (!contactOther) throw new Error("contacto no encontrado tras upsert");
    return { contact: contactOther, isNew: false };
  }

  const matchers = [eq(schema.contact.waIdentity, resolved.identity)];
  if (resolved.waUserId) {
    matchers.push(eq(schema.contact.waUserId, resolved.waUserId));
    matchers.push(
      eq(schema.contact.waIdentity, `${BSUID_PREFIX}${resolved.waUserId}`)
    );
  }
  if (resolved.phone) {
    matchers.push(eq(schema.contact.phone, resolved.phone));
  }

  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.channel, "whatsapp"),
        or(...matchers)
      )
    )
    .orderBy(schema.contact.createdAt)
    .limit(1);

  const existing = rows[0];
  if (existing) {
    const patch = contactProfilePatch(existing, resolved.profileName);
    if (resolved.waUserId && !existing.waUserId)
      patch.waUserId = resolved.waUserId;
    if (resolved.phone && !existing.phone) patch.phone = resolved.phone;
    if (existing.archivedAt) patch.archivedAt = null;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await db
        .update(schema.contact)
        .set(patch)
        .where(eq(schema.contact.id, existing.id));
      Object.assign(existing, patch);
    }
    return { contact: existing, isNew: false };
  }

  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      waIdentity: resolved.identity,
      phone: resolved.phone,
      waUserId: resolved.waUserId,
      name: resolved.profileName?.trim() || displayFallback(resolved),
      profileName: resolved.profileName?.trim() || null,
    })
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return { contact: inserted[0], isNew: true };

  // Carrera: otro request lo creó entre el SELECT y el INSERT.
  const raced = await db
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.waIdentity, resolved.identity)
      )
    )
    .limit(1);
  const contact = raced[0];
  if (!contact) throw new Error("contacto no encontrado tras upsert");
  return { contact, isNew: false };
}

/** Nombre de respaldo cuando no hay nombre de perfil: nunca el BSUID crudo. */
function displayFallback(resolved: ResolvedIdentity): string {
  if (resolved.phone) return resolved.phone;
  return "Contacto de WhatsApp";
}

/**
 * 022: qué cambia del contacto con el nombre de perfil que trae un entrante.
 *
 * - `profileName` (el nickname del canal) se actualiza siempre que venga no
 *   vacío y distinto del guardado: WhatsApp lo manda en cada mensaje.
 * - `name` solo se pisa si sigue siendo el de respaldo. Un contacto nacido de
 *   un echo (el equipo escribió primero desde la app del teléfono) se queda
 *   con su número como nombre: el echo no trae el perfil. Cuando el cliente
 *   escribe, su nombre de perfil reemplaza ese respaldo — nunca un nombre que
 *   alguien editó.
 *
 * Pura (sin BD) para el test unitario.
 */
export function contactProfilePatch(
  existing: {
    name: string;
    phone: string | null;
    waIdentity: string;
    profileName: string | null;
  },
  incoming: string | null | undefined
): Partial<typeof schema.contact.$inferInsert> {
  const patch: Partial<typeof schema.contact.$inferInsert> = {};
  const profileName = incoming?.trim();
  if (!profileName) return patch;
  if (profileName !== existing.profileName) patch.profileName = profileName;
  if (isFallbackName(existing) && profileName !== existing.name) {
    patch.name = profileName;
  }
  return patch;
}

/** 022: los genéricos "Contacto de <Canal>" que pone el alta sin perfil. */
const GENERIC_FALLBACK = /^Contacto de (WhatsApp|Instagram|Messenger)$/;

/**
 * ¿El nombre del contacto es el de respaldo (su número, su identidad o el
 * genérico) y no uno puesto por una persona? Exportada para el test unitario.
 */
export function isFallbackName(contact: {
  name: string;
  phone: string | null;
  waIdentity: string;
}): boolean {
  const name = contact.name.trim();
  if (name === "" || GENERIC_FALLBACK.test(name)) return true;
  const digits = name.replace(/\D/g, "");
  if (!digits || digits.length !== name.replace(/[\s+()-]/g, "").length) {
    return false; // trae letras: lo escribió alguien
  }
  return [contact.phone, contact.waIdentity].some(
    (v) => v != null && normalizeMx(v.replace(/\D/g, "")) === normalizeMx(digits)
  );
}
