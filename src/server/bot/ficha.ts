import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  coerceFichaPatch,
  fichaWriteBlocked,
  type FichaFieldDef,
  type FichaIgnored,
  type FichaIgnoreReason,
  type FichaMeta,
  type FichaMetaEntry,
  type FichaOutcome,
  type FichaSource,
} from "@/lib/ficha-fields";
import type { FichaValue } from "@/lib/types";
import { isSyntheticLabPhone, type PersonaSeed } from "@/server/lab/personas";

/**
 * Ficha de calificación del lead: lo que el cerebro externo va descubriendo
 * en la conversación.
 *
 * Las claves NO están cableadas. Cada negocio califica distinto —una clínica
 * pregunta el tratamiento, una constructora los metros, una agencia el
 * presupuesto— y el CRM no tiene por qué migrar cada vez que alguien cambia su
 * cuestionario. Lo que sí impone el CRM es que lo guardado sea sano: escalares,
 * acotados y en número razonable.
 *
 * La validación es FLOJA a propósito. Del otro lado hay un LLM que deriva: hoy
 * manda `dolor_principal` y mañana `dolorPrincipal`, o un `"sí"` donde antes
 * mandaba `true`. Devolverle un 422 le tira datos reales de calificación que ya
 * costaron una conversación; se prefiere guardar lo que se entienda e ignorar
 * en silencio lo que no.
 *
 * 04 — Además: procedencia por clave (`contact.ficha_meta`), regla "el humano
 * gana" y bitácora append-only (`ficha_event`). Todo vive AQUÍ: esta es la
 * única puerta que escribe `contact.ficha`, `contact.ficha_meta` y
 * `ficha_event` (guardarraíles `tests/unit/ficha-guard.test.ts` y
 * `tests/unit/ficha-provenance.test.ts`).
 */

/** Tope de claves por ficha: contiene un bot en bucle sin estorbar a nadie. */
const MAX_KEYS = 40;
const MAX_KEY_LEN = 60;
const MAX_VALUE_LEN = 500;

export type FichaInput = Record<string, unknown>;
export type Ficha = Record<string, string | number | boolean | null>;

/**
 * Deja la ficha en valores que se puedan guardar y mostrar: escalares
 * acotados. `null` sobrevive porque significa "borra esta clave". Objetos,
 * arreglos y claves absurdas se ignoran sin error.
 */
export function normalizeFicha(raw: FichaInput): Ficha {
  const out: Ficha = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [rawKey, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_KEYS) break;

    const key = rawKey.trim();
    if (!key || key.length > MAX_KEY_LEN) continue;

    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const v = value.trim();
      // La cadena vacía no borra: para eso está `null` explícito. Un LLM manda
      // "" con demasiada facilidad como para dejarlo tirar un dato bueno.
      if (v) out[key] = v.slice(0, MAX_VALUE_LEN);
      continue;
    }
    // Objetos y arreglos: fuera. Se ignoran sin error (ver arriba).
  }
  return out;
}

/** Merge campo a campo: lo ausente se conserva, `null` explícito borra. */
export function mergeFicha(prev: Ficha | null | undefined, patch: Ficha): Ficha {
  const out: Ficha = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/* ============================================================
 * 04 — Procedencia, bitácora y regla "el humano gana"
 * ============================================================ */

/** Tope de filas `invalido` por escritura: un modelo en bucle no llena la bitácora. */
const MAX_INVALID_EVENTS = 20;

/** Una fila de `ficha_event` por escribir (id y organización los pone la puerta). */
export type FichaEventDraft = {
  key: string;
  oldValue: FichaValue | null;
  newValue: FichaValue | null;
  outcome: FichaOutcome;
  reason: FichaIgnoreReason | null;
};

export type FichaWritePlan = {
  ficha: Ficha;
  meta: FichaMeta;
  ignored: FichaIgnored[];
  events: FichaEventDraft[];
  /** ¿Cambió algún valor o alguna procedencia? Sin cambios no se escribe nada. */
  changed: boolean;
};

const outcomeOf = (reason: FichaIgnoreReason): FichaOutcome =>
  reason === "candado_humano" ? "ignorado_humano" : "invalido";

function humanEntry(at: string, userId?: string | null): FichaMetaEntry {
  return userId ? { by: "humano", at, userId } : { by: "humano", at };
}

/**
 * Decide QUÉ se escribe, sin tocar la BD (pura: la prueba
 * `tests/unit/ficha-provenance.test.ts`). `upsertFicha` la llama dentro de la
 * transacción, con la fila del contacto bloqueada.
 *
 * Orden: parche normalizado (y, si escribe el agente, coercionado contra la
 * definición) → regla de procedencia (`fichaWriteBlocked`) → tope de claves
 * (las definidas primero) → merge → desbloqueos (`unlock`).
 */
export function planFichaWrite(input: {
  current: Ficha | null | undefined;
  meta: FichaMeta | null | undefined;
  raw: unknown;
  source: FichaSource;
  fields?: readonly FichaFieldDef[] | null;
  userId?: string | null;
  unlock?: readonly string[];
  now?: Date;
}): FichaWritePlan {
  const at = (input.now ?? new Date()).toISOString();
  const ficha: Ficha = { ...(input.current ?? {}) };
  const meta: FichaMeta = { ...(input.meta ?? {}) };
  const ignored: FichaIgnored[] = [];
  const events: FichaEventDraft[] = [];
  let changed = false;
  let invalidEvents = 0;

  const fields = input.fields ?? [];
  const valueOf = (key: string): FichaValue | null => {
    const v = ficha[key];
    return v === undefined || v === null ? null : v;
  };
  const reject = (
    key: string,
    reason: FichaIgnoreReason,
    attempted: FichaValue | null
  ) => {
    ignored.push({ key, reason });
    const outcome = outcomeOf(reason);
    if (outcome === "invalido") {
      if (invalidEvents >= MAX_INVALID_EVENTS) return;
      invalidEvents += 1;
    }
    events.push({
      key,
      oldValue: valueOf(key),
      // Un intento inválido queda sin valor; uno ignorado por el candado
      // conserva lo que se intentó (es un valor guardable, en la BD propia).
      newValue: outcome === "invalido" ? null : attempted,
      outcome,
      reason,
    });
  };

  // 1) Parche. El agente in-process pasa por la coerción por tipo y, sin
  //    definición, no llena nada (RF-04-02). Persona y cerebro externo
  //    conservan su contrato de claves libres (`null` borra).
  let patch: Ficha;
  if (input.source === "ia") {
    if (fields.length === 0) return { ficha, meta, ignored, events, changed };
    const coerced = coerceFichaPatch(input.raw, fields);
    patch = coerced.patch;
    for (const r of coerced.rejected) reject(r.key, r.reason, null);
  } else {
    patch =
      input.raw && typeof input.raw === "object" && !Array.isArray(input.raw)
        ? normalizeFicha(input.raw as FichaInput)
        : {};
  }

  // Las claves de la definición tienen prioridad ante el tope de 40.
  const defined = new Set(fields.map((f) => f.key));
  const entries = Object.entries(patch).sort(
    ([a], [b]) => Number(defined.has(b)) - Number(defined.has(a))
  );

  for (const [key, value] of entries) {
    const prev = valueOf(key);
    const hasValue = prev !== null;
    const entry = meta[key];

    if (value === null) {
      // Borrar (solo persona o cerebro externo: el agente no borra).
      if (!hasValue) {
        if (entry) {
          delete meta[key];
          changed = true;
        }
        continue;
      }
      const blocked = fichaWriteBlocked(input.source, entry, hasValue);
      if (blocked) {
        reject(key, blocked, null);
        continue;
      }
      delete ficha[key];
      // Sin valor no hay candado: el campo vuelve a estar libre.
      delete meta[key];
      events.push({ key, oldValue: prev, newValue: null, outcome: "aplicado", reason: null });
      changed = true;
      continue;
    }

    if (prev === value) {
      // Mismo valor: sin fila en la bitácora. Una persona que lo reenvía lo
      // está confirmando, así que sí queda con candado.
      if (input.source === "humano" && entry?.by !== "humano") {
        meta[key] = humanEntry(at, input.userId);
        changed = true;
      }
      continue;
    }

    const blocked = fichaWriteBlocked(input.source, entry, hasValue);
    if (blocked) {
      reject(key, blocked, value);
      continue;
    }
    if (!hasValue && Object.keys(ficha).length >= MAX_KEYS) {
      reject(key, "tope", value);
      continue;
    }

    ficha[key] = value;
    meta[key] =
      input.source === "humano"
        ? humanEntry(at, input.userId)
        : { by: input.source, at };
    events.push({ key, oldValue: prev, newValue: value, outcome: "aplicado", reason: null });
    changed = true;
  }

  // 2) "Dejar que el agente lo actualice" (RF-04-08): el valor se queda y la
  //    procedencia pasa a `ia`. Solo claves con valor y con candado o
  //    legadas. Sin fila en la bitácora: el valor no cambió.
  for (const key of input.unlock ?? []) {
    if (valueOf(key) === null) continue;
    const entry = meta[key];
    if (entry && entry.by !== "humano") continue;
    meta[key] = { by: "ia", at };
    changed = true;
  }

  return { ficha, meta, ignored, events, changed };
}

/**
 * Escribe la ficha. Es la ÚNICA puerta: por aquí pasan el cerebro externo
 * (`PUT /api/bot/ficha`, `source:"bot"`), la persona desde la bandeja
 * (`source:"humano"`) y el agente in-process (`source:"ia"`), así que todos
 * heredan el mismo merge —`null` borra—, las mismas cotas, la misma regla de
 * procedencia ("el humano gana", `fichaWriteBlocked`) y la misma bitácora.
 *
 * Merge y no reemplazo porque escriben a la vez: el agente va llenando
 * mientras conversa y el equipo corrige lo que ve. La fila del contacto se
 * bloquea (`FOR UPDATE`) y la regla se evalúa DENTRO de la transacción: si la
 * persona guarda mientras el turno escribe, uno espera al otro y el candado
 * se respeta.
 *
 * Devuelve `null` si el contacto no existe en esa organización.
 */
export async function upsertFicha(input: {
  organizationId: string;
  contactId: string;
  ficha: unknown;
  source: FichaSource;
  /** Solo `source:"humano"`: quién editó (queda en la meta y la bitácora). */
  userId?: string | null;
  conversationId?: string | null;
  /** Definición de campos: obligatoria para `ia`; prioridad ante el tope. */
  fields?: readonly FichaFieldDef[] | null;
  /** Claves a las que se les quita el candado, DESPUÉS de aplicar el parche. */
  unlock?: readonly string[];
}): Promise<{
  ficha: Ficha;
  meta: FichaMeta;
  ignored: FichaIgnored[];
  changed: boolean;
} | null> {
  const db = getDb();

  // El acotamiento va aquí y no en cada llamador: una ficha es información de
  // calificación de un cliente ajeno, y confiar en que quien llame se acuerde
  // de filtrar por organización es exactamente como se filtran los datos entre
  // inquilinos.
  const alcance = scoped(
    schema.contact.organizationId,
    input.organizationId,
    eq(schema.contact.id, input.contactId)
  );

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        ficha: schema.contact.ficha,
        fichaMeta: schema.contact.fichaMeta,
      })
      .from(schema.contact)
      .where(alcance)
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return null;

    const userId = input.source === "humano" ? (input.userId ?? null) : null;
    const plan = planFichaWrite({
      current: row.ficha as Ficha | null,
      meta: row.fichaMeta,
      raw: input.ficha,
      source: input.source,
      fields: input.fields,
      userId,
      unlock: input.unlock,
    });

    if (plan.changed) {
      await tx
        .update(schema.contact)
        .set({ ficha: plan.ficha, fichaMeta: plan.meta, updatedAt: new Date() })
        .where(alcance);
    }

    if (plan.events.length > 0) {
      await tx.insert(schema.fichaEvent).values(
        plan.events.map((e) => ({
          id: newId("fichaEvent"),
          organizationId: input.organizationId,
          contactId: input.contactId,
          conversationId: input.conversationId ?? null,
          key: e.key,
          oldValue: e.oldValue,
          newValue: e.newValue,
          source: input.source,
          actorUserId: userId,
          outcome: e.outcome,
          reason: e.reason,
        }))
      );
    }

    return {
      ficha: plan.ficha,
      meta: plan.meta,
      ignored: plan.ignored,
      changed: plan.changed,
    };
  });
}

/** Semilla de una persona del Laboratorio (03; la reutiliza 08). */
export type TestContactSeed = PersonaSeed;

/**
 * 03 — Reinicia el contacto SINTÉTICO de una persona del Laboratorio al
 * inicio de cada caso (RF-03-14): notas y ficha quedan en la semilla de la
 * persona, o vacías. Sin esto una corrida hereda lo que el agente escribió en
 * la anterior y deja de ser determinista.
 *
 * Vive aquí, en la ÚNICA puerta que escribe `contact.ficha`, y hace notas +
 * ficha + `ficha_meta` (04) en UN solo `update`; antes borra los eventos
 * `ficha_event` del contacto sintético (04, RF-04-15).
 *
 * PELIGROSA por diseño (borra notas y ficha), así que tiene guarda propia y
 * no confía en el llamador: solo actúa si el contacto está ARCHIVADO y su
 * identidad o teléfono es sintético del Laboratorio (prefijo `52100000`,
 * `isSyntheticLabPhone`). Si no, no toca nada y registra un warn. Devuelve
 * si reinició.
 *
 * 08 — La guarda es por PREFIJO, no por el set de personas: no lee la BD,
 * vale para personas personalizadas y archivadas, y `seed` llega del
 * `persona_snapshot` del caso.
 */
export async function resetTestContact(input: {
  organizationId: string;
  contactId: string;
  seed?: TestContactSeed;
}): Promise<boolean> {
  const db = getDb();
  const alcance = scoped(
    schema.contact.organizationId,
    input.organizationId,
    eq(schema.contact.id, input.contactId)
  );
  const rows = await db
    .select({
      archivedAt: schema.contact.archivedAt,
      waIdentity: schema.contact.waIdentity,
      phone: schema.contact.phone,
    })
    .from(schema.contact)
    .where(alcance)
    .limit(1);
  const row = rows[0];
  const synthetic =
    !!row &&
    (isSyntheticLabPhone(row.waIdentity) || isSyntheticLabPhone(row.phone));
  if (!row || !row.archivedAt || !synthetic) {
    // Sin identificadores en el log: basta con saber que la guarda paró.
    console.warn(
      "[lab] resetTestContact rechazado: el contacto no es una persona sintética archivada"
    );
    return false;
  }

  // 04 — La bitácora del contacto sintético tampoco se hereda entre casos.
  await db
    .delete(schema.fichaEvent)
    .where(
      scoped(
        schema.fichaEvent.organizationId,
        input.organizationId,
        eq(schema.fichaEvent.contactId, input.contactId)
      )
    );

  const ficha = input.seed?.ficha ? normalizeFicha(input.seed.ficha) : null;
  await db
    .update(schema.contact)
    .set({
      notes: input.seed?.notes ?? null,
      ficha: ficha && Object.keys(ficha).length > 0 ? ficha : null,
      // La semilla no trae procedencia: cuenta como dato previo (legado).
      fichaMeta: null,
      ...(input.seed?.name ? { name: input.seed.name } : {}),
      updatedAt: new Date(),
    })
    .where(alcance);
  return true;
}

export function serializeFicha(
  contact: typeof schema.contact.$inferSelect
): Ficha {
  return (contact.ficha as Ficha | null) ?? {};
}

/** 04 — Procedencia por clave; `{}` si nadie ha escrito desde 04. */
export function serializeFichaMeta(
  contact: Pick<typeof schema.contact.$inferSelect, "fichaMeta">
): FichaMeta {
  return contact.fichaMeta ?? {};
}
