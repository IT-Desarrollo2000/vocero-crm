import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * 017 — Credenciales del canal de Messenger (una Página por organización).
 *
 * Mismo contrato que las de WhatsApp e Instagram: el token de la Página viaja
 * descifrado solo en memoria y hacia fuera se expone únicamente su cola.
 */

export type MessengerCredentials = {
  id: string;
  organizationId: string;
  pageId: string;
  pageName: string | null;
  status: "connected" | "reconnect_required";
  token: string;
};

type Row = typeof schema.messengerCredentials.$inferSelect;

function toCredentials(row: Row): MessengerCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    pageId: row.pageId,
    pageName: row.pageName,
    status: row.status,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
  };
}

export async function getMessengerCredentialsByOrg(
  organizationId: string
): Promise<MessengerCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Enrutado del webhook: `entry[].id` es el id de la Página. */
export async function getMessengerCredentialsByPageId(
  pageId: string
): Promise<MessengerCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.pageId, pageId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveMessengerCredentials(input: {
  organizationId: string;
  pageId: string;
  pageName: string | null;
  token: string;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const existing = await getMessengerCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    pageId: input.pageId,
    pageName: input.pageName,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    status: "connected" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(schema.messengerCredentials)
      .set(values)
      .where(eq(schema.messengerCredentials.id, existing.id));
    return;
  }
  await db
    .insert(schema.messengerCredentials)
    .values({ id: newId("credentials"), ...values });
}

export async function deleteMessengerCredentials(
  organizationId: string
): Promise<void> {
  await getDb()
    .delete(schema.messengerCredentials)
    .where(eq(schema.messengerCredentials.organizationId, organizationId));
}

/** El token murió: se pausan los envíos y la UI pide reconectar. */
export async function markMessengerReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.messengerCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(eq(schema.messengerCredentials.organizationId, organizationId));
}
