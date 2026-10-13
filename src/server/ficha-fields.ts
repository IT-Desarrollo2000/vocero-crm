import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { FichaFieldDef } from "@/lib/ficha-fields";

/**
 * 04 — Definición de campos de la ficha (`agent_profile.ficha_fields`).
 * Una fila por organización; NULL = sin definición (ficha libre y el agente
 * in-process no llena nada, RF-04-02).
 */

/** `undefined` = la organización no tiene `agent_profile`. */
export async function getFichaFields(
  organizationId: string
): Promise<FichaFieldDef[] | null | undefined> {
  const rows = await getDb()
    .select({ fichaFields: schema.agentProfile.fichaFields })
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return row.fichaFields ?? null;
}

/**
 * Guarda la definición ya validada (`fichaFieldsSchema`). `[]` se guarda como
 * NULL. NO toca valores guardados en `contact.ficha`: renombrar o borrar un
 * campo deja sus valores como claves libres. Devuelve `undefined` si no hay
 * `agent_profile`.
 */
export async function setFichaFields(
  organizationId: string,
  fields: FichaFieldDef[] | null
): Promise<FichaFieldDef[] | null | undefined> {
  const value = fields && fields.length > 0 ? fields : null;
  const updated = await getDb()
    .update(schema.agentProfile)
    .set({ fichaFields: value, updatedAt: new Date() })
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .returning({ fichaFields: schema.agentProfile.fichaFields });
  if (!updated[0]) return undefined;
  return updated[0].fichaFields ?? null;
}

/** Atajo para lecturas que no distinguen "sin perfil" de "sin definición". */
export async function fichaFieldsOrNull(
  organizationId: string
): Promise<FichaFieldDef[] | null> {
  return (await getFichaFields(organizationId)) ?? null;
}

