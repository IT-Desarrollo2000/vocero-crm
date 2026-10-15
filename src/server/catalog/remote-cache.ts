import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 019 fase B (FR-942/943/945) — Caché de ids remotos de los archivos del
 * catálogo: lo que Meta ya tiene subido para (archivo, canal, cuenta).
 *
 *   - WhatsApp: media id de `POST /{phone_number_id}/media`. Meta lo guarda
 *     30 días; se reutiliza solo si se subió hace menos de 25 (margen para
 *     no rozar la caducidad).
 *   - Messenger: `attachment_id` de la Attachment Upload API con
 *     `is_reusable: true`. Meta: "Attachment IDs expire after 90 days"
 *     (saving-assets, oct-2026); se reutiliza solo si tiene menos de 85.
 *   - Instagram: nada que cachear (envía por URL firmada del CRM).
 *
 * El llamador (`sendMediaMessage`) solo llega aquí DESPUÉS de `prepareSend`
 * (FR-944): una conversación `is_test` no consulta ni escribe esta tabla.
 * Reemplazar o borrar un archivo invalida sus ids por el CASCADE de
 * `product_file` (no hay operación que cambie los bytes de una fila: un
 * archivo nuevo es una fila nueva).
 */

export type RemoteChannel = "whatsapp" | "messenger";

/** Vida útil reutilizable por canal; null = sin caducidad. */
export const REMOTE_ID_TTL_MS: Record<RemoteChannel, number | null> = {
  whatsapp: 25 * 24 * 60 * 60 * 1000,
  messenger: 85 * 24 * 60 * 60 * 1000,
};

type Key = {
  organizationId: string;
  productFileId: string;
  channel: RemoteChannel;
  /** phone_number_id (WhatsApp) o page id (Messenger). */
  accountId: string;
};

function keyWhere(key: Key) {
  const t = schema.productFileUpload;
  return scoped(
    t.organizationId,
    key.organizationId,
    and(
      eq(t.productFileId, key.productFileId),
      eq(t.channel, key.channel),
      eq(t.accountId, key.accountId)
    )
  );
}

/** Id remoto reutilizable o null (no hay, o en WhatsApp ya pasó de 25 días). */
export async function getReusableRemoteId(
  key: Key,
  now: Date = new Date()
): Promise<string | null> {
  const t = schema.productFileUpload;
  const rows = await getDb()
    .select({ remoteId: t.remoteId, uploadedAt: t.uploadedAt })
    .from(t)
    .where(keyWhere(key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ttl = REMOTE_ID_TTL_MS[key.channel];
  if (ttl !== null && row.uploadedAt.getTime() <= now.getTime() - ttl) return null;
  return row.remoteId;
}

/**
 * Guarda el id de una subida NUEVA (upsert por la llave única). No se llama
 * al reutilizar: `uploaded_at` es el reloj de Meta y refrescarlo alargaría
 * en silencio la ventana de 25 días.
 */
export async function saveRemoteId(
  key: Key & { remoteId: string },
  now: Date = new Date()
): Promise<void> {
  const t = schema.productFileUpload;
  await getDb()
    .insert(t)
    .values({
      id: newId("productFileUpload"),
      organizationId: key.organizationId,
      productFileId: key.productFileId,
      channel: key.channel,
      accountId: key.accountId,
      remoteId: key.remoteId,
      uploadedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.productFileId, t.channel, t.accountId],
      set: { remoteId: key.remoteId, uploadedAt: now },
    });
}

/** Olvida el id (Meta lo rechazó): el siguiente envío vuelve a subir. */
export async function forgetRemoteId(key: Key): Promise<void> {
  const t = schema.productFileUpload;
  await getDb().delete(t).where(keyWhere(key));
}
