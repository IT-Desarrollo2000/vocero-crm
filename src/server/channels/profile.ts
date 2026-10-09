import { eq } from "drizzle-orm";
import { CHANNEL_LABEL } from "@/lib/channels";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

const PROFILE_TIMEOUT_MS = 5000;

/**
 * Nombre de un contacto de Instagram o Messenger. Sus webhooks no lo traen:
 * se pide a la plataforma SOLO cuando el contacto es nuevo o sigue con el
 * nombre de respaldo ("Contacto de Messenger"), así que no cuesta una llamada
 * por mensaje y nunca pisa un nombre que el operador ya editó. Un fallo de la
 * plataforma deja el respaldo: jamás bloquea la ingesta.
 *
 * Devuelve el nombre para crear el contacto (o null para usar el respaldo).
 * Si el contacto ya existía con el respaldo, lo actualiza aquí mismo.
 */
export async function resolveChannelProfileName(input: {
  organizationId: string;
  channel: "instagram" | "messenger";
  identity: string;
  fetchName: () => Promise<string | null>;
}): Promise<string | null> {
  const db = getDb();
  const fallback = `Contacto de ${CHANNEL_LABEL[input.channel]}`;
  const rows = await db
    .select({ id: schema.contact.id, name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        input.organizationId,
        eq(schema.contact.channel, input.channel),
        eq(schema.contact.waIdentity, input.identity)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (existing && existing.name !== fallback) return null;

  // Con tope de tiempo: una plataforma lenta no debe retrasar la ingesta.
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), PROFILE_TIMEOUT_MS)
  );
  const name =
    (await Promise.race([input.fetchName(), timeout]).catch(() => null))?.trim() ||
    null;
  if (name && existing) {
    await db
      .update(schema.contact)
      .set({ name, updatedAt: new Date() })
      .where(
        scoped(
          schema.contact.organizationId,
          input.organizationId,
          eq(schema.contact.id, existing.id)
        )
      );
  }
  return name;
}
