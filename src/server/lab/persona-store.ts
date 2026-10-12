import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { LabError } from "@/server/lab/errors";
import {
  PERSONAS_AUTOS,
  PERSONAS_NEUTRO,
  chooseSeedSet,
  compileExpectFicha,
  isSyntheticLabPhone,
  seedPersonas,
  serializeExpectFicha,
  syntheticLabPhone,
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

// ── Reglas puras: clave y teléfono ───────────────────────────────────────

/** Claves de semilla (los dos sets comparten claves): reservadas siempre. */
const SEED_KEYS: ReadonlySet<string> = new Set(
  [...PERSONAS_AUTOS, ...PERSONAS_NEUTRO].map((p) => p.key)
);

const KEY_MAX = 48;

/** Slug del nombre: `[a-z0-9_]`, sin acentos; vacío → `persona`. */
export function slugKey(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, KEY_MAX)
    .replace(/_+$/g, "");
  return slug || "persona";
}

/**
 * Clave única en la org: el slug, o `slug_2`, `slug_3`… si choca con otra
 * persona (aunque esté archivada: el UNIQUE sigue vigente) o con una clave
 * de semilla.
 */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  const isTaken = (k: string) => taken.has(k) || SEED_KEYS.has(k);
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

function phoneSeq(phone: string): number {
  return isSyntheticLabPhone(phone) ? Number(phone.slice(-5)) : 0;
}

/** Las semillas ocupan las primeras secuencias (`…00001..7`). */
const SEED_PHONE_SEQ_MAX = Math.max(
  ...[...PERSONAS_AUTOS, ...PERSONAS_NEUTRO].map((p) => phoneSeq(p.phone))
);

/**
 * Siguiente teléfono sintético de la org (regla 1 del contrato): máx.
 * secuencia usada — incluidas archivadas y nunca por debajo de las de
 * semilla — + 1. Jamás un número del cliente.
 */
export function nextSyntheticPhone(phones: readonly string[]): string {
  const max = Math.max(SEED_PHONE_SEQ_MAX, ...phones.map(phoneSeq));
  return syntheticLabPhone(max + 1);
}

// ── Lecturas ─────────────────────────────────────────────────────────────

/** Personas de la org (sin archivadas salvo `includeArchived`), por `position`. */
export async function listPersonas(
  organizationId: string,
  opts?: { includeArchived?: boolean }
): Promise<LabPersonaDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.labPersona)
    .where(
      scoped(
        schema.labPersona.organizationId,
        organizationId,
        opts?.includeArchived ? undefined : isNull(schema.labPersona.archivedAt)
      )
    )
    .orderBy(asc(schema.labPersona.position), asc(schema.labPersona.key));
  return rows.map(rowToLabPersonaDto);
}

/** D-08-06: ¿hay una corrida `running`? La UI avisa; no se bloquea nada. */
export async function hasRunInProgress(organizationId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.agentTestRun.id })
    .from(schema.agentTestRun)
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        organizationId,
        eq(schema.agentTestRun.status, "running")
      )
    )
    .limit(1);
  return !!rows[0];
}

// ── Escrituras ───────────────────────────────────────────────────────────

/**
 * Crea una persona: key slug única (sufijo `_2`…), teléfono sintético
 * siguiente, `contactName` por defecto `[Prueba] <name>` y al final de la
 * lista. Un candado consultivo por organización serializa las altas
 * simultáneas (la key tiene UNIQUE; el teléfono no).
 */
export async function createPersona(
  organizationId: string,
  input: LabPersonaCreateInput
): Promise<LabPersonaDto> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`lab_persona:${organizationId}`}))`
    );
    const existing = await tx
      .select({
        key: schema.labPersona.key,
        phone: schema.labPersona.phone,
        position: schema.labPersona.position,
      })
      .from(schema.labPersona)
      .where(scoped(schema.labPersona.organizationId, organizationId));

    const key = uniqueKey(slugKey(input.name), new Set(existing.map((r) => r.key)));
    const phone = nextSyntheticPhone(existing.map((r) => r.phone));
    const position =
      input.position ?? Math.max(-1, ...existing.map((r) => r.position)) + 1;
    const now = new Date();
    const inserted = await tx
      .insert(schema.labPersona)
      .values({
        id: newId("labPersona"),
        organizationId,
        key,
        name: input.name,
        objetivo: input.objetivo ?? "",
        rasgos: input.rasgos || null,
        guion: [...input.guion],
        criteriosExito: input.criteriosExito || null,
        contactName: input.contactName ?? `[Prueba] ${input.name}`,
        phone,
        seed: input.seed ?? null,
        expectFicha: input.expectFicha ?? [],
        seedSet: null,
        active: input.active ?? true,
        position,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToLabPersonaDto(inserted[0]!);
  });
}

/** Edita una persona (`key` y `phone` inmutables). 404 si no es de la org. */
export async function updatePersona(
  organizationId: string,
  id: string,
  input: LabPersonaPatchInput
): Promise<LabPersonaDto> {
  const set: Partial<typeof schema.labPersona.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.objetivo !== undefined) set.objetivo = input.objetivo;
  if (input.rasgos !== undefined) set.rasgos = input.rasgos || null;
  if (input.guion !== undefined) set.guion = [...input.guion];
  if (input.criteriosExito !== undefined) {
    set.criteriosExito = input.criteriosExito || null;
  }
  if (input.contactName !== undefined) set.contactName = input.contactName;
  if (input.seed !== undefined) set.seed = input.seed;
  if (input.expectFicha !== undefined) set.expectFicha = input.expectFicha;
  if (input.active !== undefined) set.active = input.active;
  if (input.position !== undefined) set.position = input.position;

  const updated = await getDb()
    .update(schema.labPersona)
    .set(set)
    .where(
      scoped(
        schema.labPersona.organizationId,
        organizationId,
        eq(schema.labPersona.id, id)
      )
    )
    .returning();
  if (!updated[0]) throw new LabError("not_found", "Persona no encontrada");
  return rowToLabPersonaDto(updated[0]);
}

/**
 * Archiva (`archived_at`, `active = false`). Idempotente: una ya archivada
 * conserva su fecha. Las corridas pasadas siguen legibles por su snapshot.
 */
export async function archivePersona(
  organizationId: string,
  id: string
): Promise<LabPersonaDto> {
  const updated = await getDb()
    .update(schema.labPersona)
    .set({
      archivedAt: sql`coalesce(${schema.labPersona.archivedAt}, now())`,
      active: false,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.labPersona.organizationId,
        organizationId,
        eq(schema.labPersona.id, id)
      )
    )
    .returning();
  if (!updated[0]) throw new LabError("not_found", "Persona no encontrada");
  return rowToLabPersonaDto(updated[0]);
}

export type RestoreStep = {
  key: string;
  /** insert = falta · rewrite = es de otro set · reactivate = archivada/inactiva. */
  action: "insert" | "rewrite" | "reactivate";
};

/**
 * Qué hacer con cada persona de semilla al restaurar (puro). `rows` = filas
 * de la org con clave de semilla (una personalizada nunca la ocupa: la regla
 * de sufijo las reserva). Con el mismo set y todo activo → plan vacío.
 */
export function planRestore(
  set: LabSeedSet,
  rows: readonly Pick<LabPersonaRow, "key" | "seedSet" | "active" | "archivedAt">[]
): RestoreStep[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const plan: RestoreStep[] = [];
  for (const p of seedPersonas(set)) {
    const row = byKey.get(p.key);
    if (!row) plan.push({ key: p.key, action: "insert" });
    else if (row.seedSet !== set) plan.push({ key: p.key, action: "rewrite" });
    else if (row.archivedAt || !row.active) {
      plan.push({ key: p.key, action: "reactivate" });
    }
  }
  return plan;
}

/**
 * RF-08-03: inserta las de semilla que falten y desarchiva/activa las
 * archivadas, sin tocar las personalizadas ni el contenido de las semillas
 * activas. Con `set` distinto al que tiene la org, reescribe el contenido de
 * las filas de semilla (guion, objetivo, semilla, `expect_ficha`, `seed_set`)
 * con el del set pedido; la posición se conserva. Idempotente: repetirla
 * con el mismo set no restaura nada.
 */
export async function restoreDefaultPersonas(
  organizationId: string,
  set?: LabSeedSet
): Promise<LabRestoreDefaultsResponse> {
  const result = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.labPersona)
      .where(scoped(schema.labPersona.organizationId, organizationId));

    let target: LabSeedSet | null =
      set ?? rows.find((r) => r.seedSet)?.seedSet ?? null;
    if (!target) {
      const runs = await tx
        .select({ id: schema.agentTestRun.id })
        .from(schema.agentTestRun)
        .where(scoped(schema.agentTestRun.organizationId, organizationId))
        .limit(1);
      target = chooseSeedSet(!!runs[0]);
    }
    const seedSet = target;
    const personas = seedPersonas(seedSet);
    const plan = planRestore(
      seedSet,
      rows.filter((r) => SEED_KEYS.has(r.key))
    );
    const now = new Date();

    for (const step of plan) {
      const position = personas.findIndex((p) => p.key === step.key);
      const fresh = seedRow(organizationId, seedSet, personas[position]!, position, now);
      if (step.action === "insert") {
        await tx
          .insert(schema.labPersona)
          .values(fresh)
          .onConflictDoNothing({
            target: [schema.labPersona.organizationId, schema.labPersona.key],
          });
        continue;
      }
      const content =
        step.action === "rewrite"
          ? {
              name: fresh.name,
              objetivo: fresh.objetivo,
              rasgos: fresh.rasgos,
              guion: fresh.guion,
              criteriosExito: fresh.criteriosExito,
              contactName: fresh.contactName,
              phone: fresh.phone,
              seed: fresh.seed,
              expectFicha: fresh.expectFicha,
              seedSet,
            }
          : {};
      await tx
        .update(schema.labPersona)
        .set({ ...content, active: true, archivedAt: null, updatedAt: now })
        .where(
          scoped(
            schema.labPersona.organizationId,
            organizationId,
            eq(schema.labPersona.key, step.key)
          )
        );
    }
    return { set: seedSet, restored: plan.map((s) => s.key) };
  });

  return { ...result, personas: await listPersonas(organizationId) };
}
