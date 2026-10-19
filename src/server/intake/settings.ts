import { randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";
import type { IntakeOrigin } from "./contract";

/**
 * 011 — La clave con la que el ERP entrega sus leads (`X-API-Key`).
 *
 * Se cifra con el MISMO mecanismo que el token de WhatsApp (`lib/crypto`,
 * AES-256-GCM). La clave completa sale UNA sola vez, en la respuesta de
 * generarla/rotarla, para que el dueño la pegue en el Vault del ERP; después
 * la vista solo dice sus últimos 4. Jamás va a un log.
 */

/** Lo que puede ver el cliente. La clave NUNCA sale: solo sus últimos 4. */
export type IntakeSettingsView = {
  keyLast4: string;
  /** ISO del último lead aceptado, por origen. */
  lastReceivedAt: Partial<Record<IntakeOrigin, string>>;
  createdAt: string;
  updatedAt: string;
};

/** 32 bytes aleatorios en base64url (43 caracteres, sin relleno). */
export function generateIntakeKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Comparación en tiempo constante. Longitudes distintas → false sin comparar
 * (la longitud de la clave no es secreta: siempre son 43 caracteres).
 */
export function intakeKeyMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadRow(organizationId: string) {
  const rows = await getDb()
    .select()
    .from(schema.intakeSettings)
    .where(scoped(schema.intakeSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getIntakeSettingsView(
  organizationId: string
): Promise<IntakeSettingsView | null> {
  const row = await loadRow(organizationId);
  if (!row) return null;
  return {
    keyLast4: row.keyLast4,
    lastReceivedAt: row.lastReceivedAt ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Genera una clave nueva (o rota la existente: la vieja deja de valer en ese
 * instante). Devuelve la clave COMPLETA — la única vez que sale del servidor.
 */
export async function rotateIntakeKey(organizationId: string): Promise<string> {
  const key = generateIntakeKey();
  const enc = encryptSecret(key);
  const last4 = key.slice(-4);
  await getDb()
    .insert(schema.intakeSettings)
    .values({
      id: newId("intakeSettings"),
      organizationId,
      keyCipher: enc.cipher,
      keyIv: enc.iv,
      keyTag: enc.tag,
      keyLast4: last4,
    })
    .onConflictDoUpdate({
      target: [schema.intakeSettings.organizationId],
      set: {
        keyCipher: enc.cipher,
        keyIv: enc.iv,
        keyTag: enc.tag,
        keyLast4: last4,
        updatedAt: new Date(),
      },
    });
  return key;
}

/** Revoca: sin fila no hay clave y el endpoint responde 401 a todo. */
export async function revokeIntakeKey(organizationId: string): Promise<void> {
  await getDb()
    .delete(schema.intakeSettings)
    .where(scoped(schema.intakeSettings.organizationId, organizationId));
}

/** ¿`provided` es la clave vigente de la organización? */
export async function verifyIntakeKey(
  organizationId: string,
  provided: string
): Promise<boolean> {
  const row = await loadRow(organizationId);
  if (!row) return false;
  let expected: string;
  try {
    expected = decryptSecret({
      cipher: row.keyCipher,
      iv: row.keyIv,
      tag: row.keyTag,
    });
  } catch {
    // Clave de cifrado cambiada o fila manipulada: no autoriza a nadie.
    return false;
  }
  return intakeKeyMatches(expected, provided);
}

/** Anota la hora del último lead aceptado de ese origen (para Ajustes). */
export async function recordIntakeReceived(
  organizationId: string,
  origin: IntakeOrigin,
  at: Date = new Date()
): Promise<void> {
  const patch = JSON.stringify({ [origin]: at.toISOString() });
  await getDb()
    .update(schema.intakeSettings)
    .set({
      lastReceivedAt: sql`coalesce(${schema.intakeSettings.lastReceivedAt}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(scoped(schema.intakeSettings.organizationId, organizationId));
}
