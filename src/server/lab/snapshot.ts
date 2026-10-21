import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  LAB_SNAPSHOT_KB_MAX_BYTES,
  type LabConfigSnapshot,
  type LabKbSnapshotEntry,
} from "@/lib/lab";
import { personaHash, type LabPersona } from "@/server/lab/personas";
import { normalizeFormality } from "@/lib/formality";

/**
 * 08 — `agent_test_run.config_snapshot` (RF-08-15, D-08-04): perfil + KB +
 * personas + modelos al crear la corrida. Nunca secretos: del perfil solo
 * los textos que ve el agente; de los modelos, solo su nombre.
 */

type ProfileRow = Pick<
  typeof schema.agentProfile.$inferSelect,
  "name" | "tone" | "instructions" | "escalationRules" | "greeting"
> & {
  /** 025 — Trato (opcional en filas de prueba). */
  formality?: "tu" | "usted" | null;
};
type KbRow = Pick<
  typeof schema.kbEntry.$inferSelect,
  "id" | "kind" | "question" | "answer" | "content" | "updatedAt"
>;

/** Hash de una entrada del KB (modo `hashed` y comparación en el diff). */
export function kbEntryHash(e: {
  question: string | null;
  answer: string | null;
  content: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([e.question, e.answer, e.content]))
    .digest("hex");
}

/**
 * Arma el snapshot (puro). Si el JSON de las entradas completas supera
 * `maxKbBytes` (1 MB) → `kb.mode = "hashed"`: solo `id`, `kind`, `hash`,
 * `updatedAt`.
 */
export function buildConfigSnapshot(input: {
  profile: ProfileRow | null;
  kb: readonly KbRow[];
  personas: readonly LabPersona[];
  models: { agent: string | null; judge: string | null };
  now?: Date;
  maxKbBytes?: number;
}): LabConfigSnapshot {
  const full: LabKbSnapshotEntry[] = input.kb.map((e) => ({
    id: e.id,
    kind: e.kind,
    question: e.question,
    answer: e.answer,
    content: e.content,
    updatedAt: e.updatedAt.toISOString(),
  }));
  const max = input.maxKbBytes ?? LAB_SNAPSHOT_KB_MAX_BYTES;
  const hashed = Buffer.byteLength(JSON.stringify(full), "utf8") > max;
  const p = input.profile;
  return {
    version: 1,
    takenAt: (input.now ?? new Date()).toISOString(),
    profile: p
      ? {
          name: p.name,
          tone: p.tone,
          instructions: p.instructions,
          escalationRules: p.escalationRules,
          greeting: p.greeting,
          ...(p.formality ? { formality: normalizeFormality(p.formality) } : {}),
        }
      : null,
    kb: hashed
      ? {
          mode: "hashed",
          entries: input.kb.map((e) => ({
            id: e.id,
            kind: e.kind,
            hash: kbEntryHash(e),
            updatedAt: e.updatedAt.toISOString(),
          })),
        }
      : { mode: "full", entries: full },
    personas: input.personas.map((x) => ({
      id: x.id,
      key: x.key,
      name: x.name,
      hash: personaHash(x),
    })),
    models: input.models,
  };
}

/** Lee perfil y KB de la org y arma el snapshot de la corrida. */
export async function loadConfigSnapshot(
  organizationId: string,
  personas: readonly LabPersona[]
): Promise<LabConfigSnapshot> {
  const db = getDb();
  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(scoped(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  return buildConfigSnapshot({
    profile: profileRows[0] ?? null,
    kb,
    personas,
    models: {
      agent: process.env.OPENROUTER_MODEL?.trim() || null,
      judge: process.env.OPENROUTER_JUDGE_MODEL?.trim() || null,
    },
  });
}

/**
 * Texto de comportamiento para el juez, desde el perfil del snapshot. 025
 * (A9) — Con el trato: si el negocio habla de usted, el juez no debe
 * penalizarlo como tono frío (ni el tuteo si es de tú).
 */
export function behaviorTextOf(profile: LabConfigSnapshot["profile"]): string {
  if (!profile) return "";
  return [
    `Nombre: ${profile.name}`,
    profile.tone ? `Tono: ${profile.tone}` : null,
    profile.formality
      ? `Trato: ${profile.formality === "usted" ? "usted" : "tú"}`
      : null,
    profile.instructions ? `Instrucciones: ${profile.instructions}` : null,
    profile.escalationRules ? `Escalado: ${profile.escalationRules}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
