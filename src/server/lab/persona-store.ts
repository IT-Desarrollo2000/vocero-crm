import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type {
  LabPersonaCreateInput,
  LabPersonaDto,
  LabPersonaPatchInput,
  LabRestoreDefaultsResponse,
  LabSeedSet,
} from "@/lib/lab";
import { LabError, labNotImplemented } from "@/server/lab/errors";
import {
  chooseSeedSet,
  compileExpectFicha,
  seedPersonas,
  serializeExpectFicha,
  type LabPersona,
  type Persona,
} from "@/server/lab/personas";

/**
 * 08 — Personas del Laboratorio por organización (`lab_persona`), «Contrato
 * 08-0». Toda query pasa por `scoped()`.
 */

type LabPersonaRow = typeof schema.labPersona.$inferSelect;

/** Fila de semilla para una persona de un set en código. */
export function seedRow(
  organizationId: string,
  set: LabSeedSet,
  p: Persona,
  position: number,
  now: Date
): typeof schema.labPersona.$inferInsert {
  return {
    id: newId("labPersona"),
    organizationId,
    key: p.key,
    name: p.label,
    objetivo: p.description,
    rasgos: null,
    guion: [...p.script],
    criteriosExito: null,
    contactName: p.contactName,
    phone: p.phone,
    seed: p.seed ?? null,
    expectFicha: serializeExpectFicha(p.expectFicha),
    seedSet: set,
    active: true,
    position,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Siembra perezosa e idempotente (RF-08-02, D-08-01). Si la organización ya
 * tiene ALGUNA persona (activa, inactiva o archivada) no hace nada. Si no:
 * con alguna fila en `agent_test_run` recibe el set `autos` (las personas de
 * siempre); sin corridas, el set `neutro`. `ON CONFLICT (organization_id,
 * key) DO NOTHING`: dos llamadas simultáneas no duplican.
 *
 * Orden obligatorio en `POST /api/lab/runs`: llamarla ANTES de insertar la
 * corrida (si no, una org nueva se vería "con corridas" y recibiría `autos`).
 *
 * Devuelve el set sembrado, o `null` si no sembró.
 */
export async function ensureSeedPersonas(
  organizationId: string
): Promise<LabSeedSet | null> {
  const db = getDb();
  const existing = await db
    .select({ id: schema.labPersona.id })
    .from(schema.labPersona)
    .where(scoped(schema.labPersona.organizationId, organizationId))
    .limit(1);
  if (existing[0]) return null;

  const runs = await db
    .select({ id: schema.agentTestRun.id })
    .from(schema.agentTestRun)
    .where(scoped(schema.agentTestRun.organizationId, organizationId))
    .limit(1);
  const set = chooseSeedSet(!!runs[0]);
  const now = new Date();
  await db
    .insert(schema.labPersona)
    .values(seedPersonas(set).map((p, i) => seedRow(organizationId, set, p, i, now)))
    .onConflictDoNothing({
      target: [schema.labPersona.organizationId, schema.labPersona.key],
    });
  return set;
}

/** Fila → `LabPersona` (expectFicha compilado). */
export function rowToLabPersona(row: LabPersonaRow): LabPersona {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    objetivo: row.objetivo,
    rasgos: row.rasgos,
    guion: row.guion,
    criteriosExito: row.criteriosExito,
    contactName: row.contactName,
    phone: row.phone,
    seed: row.seed ?? undefined,
    expectFicha: compileExpectFicha(row.expectFicha),
    active: row.active,
    position: row.position,
  };
}

/** Fila → DTO de la API. */
export function rowToLabPersonaDto(row: LabPersonaRow): LabPersonaDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    objetivo: row.objetivo,
    rasgos: row.rasgos,
    guion: row.guion,
    criteriosExito: row.criteriosExito,
    contactName: row.contactName,
    phone: row.phone,
    seed: row.seed ?? null,
    expectFicha: row.expectFicha,
    active: row.active,
    position: row.position,
    seedSet: row.seedSet ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Personas de una corrida: activas y sin archivar, por `position` y `key`.
 * Con `keys`, solo esas (todas deben estar activas y sin archivar; si no,
 * `LabError("unknown_persona")`). Ninguna → `LabError("no_personas")`.
 * No siembra: el llamador hace `ensureSeedPersonas` antes.
 */
export async function loadRunPersonas(
  organizationId: string,
  keys?: readonly string[]
): Promise<LabPersona[]> {
  if (keys && keys.length === 0) {
    throw new LabError("no_personas", "Elige al menos una persona");
  }
  const rows = await getDb()
    .select()
    .from(schema.labPersona)
    .where(
      scoped(
        schema.labPersona.organizationId,
        organizationId,
        and(
          eq(schema.labPersona.active, true),
          isNull(schema.labPersona.archivedAt),
          keys ? inArray(schema.labPersona.key, [...keys]) : undefined
        )
      )
    )
    .orderBy(asc(schema.labPersona.position), asc(schema.labPersona.key));

  if (keys) {
    const found = new Set(rows.map((r) => r.key));
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length > 0) {
      throw new LabError(
        "unknown_persona",
        `Personas inexistentes, archivadas o inactivas: ${missing.join(", ")}`
      );
    }
  }
  if (rows.length === 0) {
    throw new LabError("no_personas", "No hay personas activas para correr");
  }
  return rows.map(rowToLabPersona);
}

// ── Stubs (08-A) ─────────────────────────────────────────────────────────

/** Personas de la org (sin archivadas salvo `includeArchived`), por `position`. */
export async function listPersonas(
  organizationId: string,
  opts?: { includeArchived?: boolean }
): Promise<LabPersonaDto[]> {
  void organizationId;
  void opts;
  return labNotImplemented("listPersonas");
}

/** Crea una persona: key slug única (sufijo `_2`…), teléfono sintético siguiente. */
export async function createPersona(
  organizationId: string,
  input: LabPersonaCreateInput
): Promise<LabPersonaDto> {
  void organizationId;
  void input;
  return labNotImplemented("createPersona");
}

/** Edita una persona (`key` y `phone` inmutables). 404 si no es de la org. */
export async function updatePersona(
  organizationId: string,
  id: string,
  input: LabPersonaPatchInput
): Promise<LabPersonaDto> {
  void organizationId;
  void id;
  void input;
  return labNotImplemented("updatePersona");
}

/** Archiva (`archived_at = now`, `active = false`). Idempotente. */
export async function archivePersona(
  organizationId: string,
  id: string
): Promise<LabPersonaDto> {
  void organizationId;
  void id;
  return labNotImplemented("archivePersona");
}

/**
 * RF-08-03: inserta las de semilla que falten y desarchiva/activa las
 * archivadas, sin tocar las personalizadas ni el contenido de las semillas
 * activas. Con `set` distinto al que tiene la org, reescribe el contenido de
 * las filas de semilla (`seed_set` no nulo) con el del set pedido.
 */
export async function restoreDefaultPersonas(
  organizationId: string,
  set?: LabSeedSet
): Promise<LabRestoreDefaultsResponse> {
  void organizationId;
  void set;
  return labNotImplemented("restoreDefaultPersonas");
}
