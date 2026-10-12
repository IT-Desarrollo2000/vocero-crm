import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  LAB_DELTA_NOTE_DIFFERENT_SET,
  LAB_HALLAZGO_TIPOS,
  type LabConfigSnapshot,
  type LabFieldChange,
  type LabHallazgoTipo,
  type LabKbSnapshotEntry,
  type LabRunDiffDto,
  type LabRunSummaryDto,
  type LabTrendsDto,
  type LabVeredicto,
} from "@/lib/lab";
import { LabError } from "@/server/lab/errors";

/**
 * 08 — Historial del Laboratorio («Contrato 08-0»): delta comparable,
 * tendencia y "qué cambió". Las piezas puras (`computeDeltas`,
 * `aggregateTrends`, `diffSnapshots`) se prueban sin BD.
 */

type RunSetInfo = {
  personaKeys: string[] | null;
  /** `config_snapshot.personas`, si la corrida lo tiene. */
  personaHashes?: { key: string; hash: string }[] | null;
};

/**
 * RF-08-17: ¿dos corridas son comparables para el delta? Mismas claves (sin
 * importar el orden) y, si las dos tienen snapshot, mismo hash por clave.
 * Corridas anteriores a 08 (`personaKeys` null) solo se comparan entre sí.
 */
export function samePersonaSet(a: RunSetInfo, b: RunSetInfo): boolean {
  if (a.personaKeys === null || b.personaKeys === null) {
    return a.personaKeys === null && b.personaKeys === null;
  }
  const ka = [...a.personaKeys].sort();
  const kb = [...b.personaKeys].sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  if (!a.personaHashes || !b.personaHashes) return true;
  const hb = new Map(b.personaHashes.map((p) => [p.key, p.hash]));
  return a.personaHashes.every((p) => hb.get(p.key) === p.hash);
}

// ── Delta del historial (GET /api/lab/runs) ──────────────────────────────

export type RunHistoryRow = {
  id: string;
  status: "running" | "done" | "failed";
  score: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  personaKeys: string[] | null;
  personaHashes: { key: string; hash: string }[] | null;
};

/**
 * Delta de cada corrida (más reciente primero) contra la `done` anterior con
 * el MISMO conjunto. Si hay anteriores `done` pero ninguna comparable →
 * `delta: null` y `deltaNote: "conjunto distinto"`.
 */
export function computeDeltas(runs: readonly RunHistoryRow[]): LabRunSummaryDto[] {
  return runs.map((run, i): LabRunSummaryDto => {
    const previous = runs
      .slice(i + 1)
      .filter((r) => r.status === "done" && r.score !== null);
    const prev = previous.find((r) => samePersonaSet(run, r));
    const finished = run.status === "done" && run.score !== null;
    const comparable = finished && prev?.score != null;
    return {
      id: run.id,
      status: run.status,
      score: run.score,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      personaKeys: run.personaKeys,
      delta: comparable ? run.score! - prev!.score! : null,
      deltaAgainst: comparable ? prev!.id : null,
      deltaNote:
        finished && !prev && previous.length > 0 ? LAB_DELTA_NOTE_DIFFERENT_SET : null,
    };
  });
}

/** `config_snapshot -> 'personas'` (jsonb) → pares clave/hash. */
export function personaHashesOf(raw: unknown): { key: string; hash: string }[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(
      (p): p is { key: string; hash: string } =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { key?: unknown }).key === "string" &&
        typeof (p as { hash?: unknown }).hash === "string"
    )
    .map((p) => ({ key: p.key, hash: p.hash }));
}

// ── Tendencia (RF-08-10) ─────────────────────────────────────────────────

type TrendCase = {
  runId: string;
  persona: string;
  status: string;
  veredicto: string | null;
  hallazgos: unknown;
};

const TIPOS: ReadonlySet<string> = new Set(LAB_HALLAZGO_TIPOS);

/** `hallazgos` es jsonb sin tipar: solo cuentan los que traen un tipo válido. */
function tiposOf(hallazgos: unknown): LabHallazgoTipo[] {
  if (!Array.isArray(hallazgos)) return [];
  return hallazgos
    .map((h) => (typeof h === "object" && h !== null ? (h as { tipo?: unknown }).tipo : null))
    .filter((t): t is LabHallazgoTipo => typeof t === "string" && TIPOS.has(t));
}

/** Agrega los casos por corrida (puro). Respeta el orden de `runs`. */
export function aggregateTrends(
  runs: readonly {
    id: string;
    startedAt: Date;
    finishedAt: Date | null;
    score: number | null;
    personaKeys: string[] | null;
  }[],
  cases: readonly TrendCase[]
): LabTrendsDto {
  return {
    runs: runs.map((run) => {
      const hallazgosPorTipo = Object.fromEntries(
        LAB_HALLAZGO_TIPOS.map((t) => [t, 0])
      ) as Record<LabHallazgoTipo, number>;
      const veredictos: Record<string, LabVeredicto | "sin_veredicto"> = {};
      for (const c of cases) {
        if (c.runId !== run.id) continue;
        for (const t of tiposOf(c.hallazgos)) hallazgosPorTipo[t] += 1;
        if (c.status === "done" && c.veredicto) {
          veredictos[c.persona] = c.veredicto as LabVeredicto;
        } else if (c.status === "judge_failed") {
          veredictos[c.persona] = "sin_veredicto";
        }
      }
      return {
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        score: run.score,
        personaKeys: run.personaKeys,
        hallazgosPorTipo,
        veredictos,
      };
    }),
  };
}

/** RF-08-10: corridas `done` más recientes con conteos por tipo y veredictos. */
export async function runTrends(
  organizationId: string,
  limit: number
): Promise<LabTrendsDto> {
  const db = getDb();
  const runs = await db
    .select({
      id: schema.agentTestRun.id,
      startedAt: schema.agentTestRun.startedAt,
      finishedAt: schema.agentTestRun.finishedAt,
      score: schema.agentTestRun.score,
      personaKeys: schema.agentTestRun.personaKeys,
    })
    .from(schema.agentTestRun)
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        organizationId,
        eq(schema.agentTestRun.status, "done")
      )
    )
    .orderBy(desc(schema.agentTestRun.startedAt))
    .limit(limit);
  if (runs.length === 0) return { runs: [] };

  const cases = await db
    .select({
      runId: schema.agentTestCase.runId,
      persona: schema.agentTestCase.persona,
      status: schema.agentTestCase.status,
      veredicto: schema.agentTestCase.veredicto,
      hallazgos: schema.agentTestCase.hallazgos,
    })
    .from(schema.agentTestCase)
    .where(
      scoped(
        schema.agentTestCase.organizationId,
        organizationId,
        inArray(
          schema.agentTestCase.runId,
          runs.map((r) => r.id)
        )
      )
    );
  return aggregateTrends(
    runs.map((r) => ({ ...r, personaKeys: r.personaKeys ?? null })),
    cases
  );
}

// ── "Qué cambió" (RF-08-16) ──────────────────────────────────────────────

const PROFILE_FIELDS = [
  "name",
  "tone",
  "instructions",
  "escalationRules",
  "greeting",
] as const;

function change(before: string | null, after: string | null): LabFieldChange | null {
  return before === after ? null : { before, after };
}

function isFull(
  e: LabKbSnapshotEntry
): e is Extract<LabKbSnapshotEntry, { question: string | null }> {
  return !("hash" in e);
}

function kbEdited(a: LabKbSnapshotEntry, b: LabKbSnapshotEntry): boolean {
  if (isFull(a) && isFull(b)) {
    return (
      a.kind !== b.kind ||
      a.question !== b.question ||
      a.answer !== b.answer ||
      a.content !== b.content
    );
  }
  if (!isFull(a) && !isFull(b)) return a.hash !== b.hash;
  // Un lado solo con hash: sin texto que comparar, manda la fecha.
  return a.updatedAt !== b.updatedAt;
}

/**
 * Diff puro entre dos snapshots: `before` = la corrida contra la que se
 * compara, `after` = la corrida pedida. Con algún KB en modo `hashed` las
 * entradas editadas van sin texto (`before`/`after` = null).
 */
export function diffSnapshots(
  before: LabConfigSnapshot,
  after: LabConfigSnapshot
): Omit<Extract<LabRunDiffDto, { available: true }>, "available" | "runId" | "againstId"> {
  const profile: Extract<LabRunDiffDto, { available: true }>["profile"] = {};
  for (const f of PROFILE_FIELDS) {
    const c = change(before.profile?.[f] ?? null, after.profile?.[f] ?? null);
    if (c) profile[f] = c;
  }

  const kbBefore = new Map(before.kb.entries.map((e) => [e.id, e]));
  const kbAfter = new Map(after.kb.entries.map((e) => [e.id, e]));
  const withText = before.kb.mode === "full" && after.kb.mode === "full";
  const edited: { id: string; before: LabKbSnapshotEntry | null; after: LabKbSnapshotEntry | null }[] = [];
  for (const [id, a] of kbAfter) {
    const b = kbBefore.get(id);
    if (b && kbEdited(b, a)) {
      edited.push({ id, before: withText ? b : null, after: withText ? a : null });
    }
  }

  const pBefore = new Map(before.personas.map((p) => [p.key, p.hash]));
  const pAfter = new Map(after.personas.map((p) => [p.key, p.hash]));

  return {
    profile,
    kb: {
      added: [...kbAfter.values()].filter((e) => !kbBefore.has(e.id)),
      removed: [...kbBefore.values()].filter((e) => !kbAfter.has(e.id)),
      edited,
    },
    personas: {
      added: [...pAfter.keys()].filter((k) => !pBefore.has(k)),
      removed: [...pBefore.keys()].filter((k) => !pAfter.has(k)),
      edited: [...pAfter.entries()]
        .filter(([k, h]) => pBefore.has(k) && pBefore.get(k) !== h)
        .map(([k]) => k),
    },
    models: {
      agent: change(before.models.agent, after.models.agent),
      judge: change(before.models.judge, after.models.judge),
    },
  };
}

/**
 * RF-08-16: diff de snapshots entre `runId` y `againstId` (default: la
 * corrida `done` anterior con snapshot). 404 `LabError("not_found")` si
 * alguna no es de la org; `{ available: false }` si falta snapshot o no hay
 * anterior.
 */
export async function diffRuns(
  organizationId: string,
  runId: string,
  againstId?: string
): Promise<LabRunDiffDto> {
  const db = getDb();
  const cols = {
    id: schema.agentTestRun.id,
    startedAt: schema.agentTestRun.startedAt,
    configSnapshot: schema.agentTestRun.configSnapshot,
  };
  const runs = await db
    .select(cols)
    .from(schema.agentTestRun)
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        organizationId,
        eq(schema.agentTestRun.id, runId)
      )
    )
    .limit(1);
  const run = runs[0];
  if (!run) throw new LabError("not_found", "Corrida no encontrada");

  let against: (typeof runs)[number] | undefined;
  if (againstId) {
    const rows = await db
      .select(cols)
      .from(schema.agentTestRun)
      .where(
        scoped(
          schema.agentTestRun.organizationId,
          organizationId,
          eq(schema.agentTestRun.id, againstId)
        )
      )
      .limit(1);
    against = rows[0];
    if (!against) throw new LabError("not_found", "Corrida de comparación no encontrada");
  } else {
    const previousDone = and(
      eq(schema.agentTestRun.status, "done"),
      lt(schema.agentTestRun.startedAt, run.startedAt)
    );
    const rows = await db
      .select(cols)
      .from(schema.agentTestRun)
      .where(
        scoped(
          schema.agentTestRun.organizationId,
          organizationId,
          previousDone,
          isNotNull(schema.agentTestRun.configSnapshot)
        )
      )
      .orderBy(desc(schema.agentTestRun.startedAt))
      .limit(1);
    against = rows[0];
    if (!against) {
      // ¿Hay anterior pero sin snapshot (anterior a 08)? Entonces no es que
      // no haya con qué comparar: es que no hay snapshot.
      const older = await db
        .select({ id: schema.agentTestRun.id })
        .from(schema.agentTestRun)
        .where(
          scoped(schema.agentTestRun.organizationId, organizationId, previousDone)
        )
        .orderBy(desc(schema.agentTestRun.startedAt))
        .limit(1);
      return {
        available: false,
        reason: older[0] ? "no_snapshot" : "no_previous",
        runId: run.id,
        againstId: older[0]?.id ?? null,
      };
    }
  }

  if (!run.configSnapshot || !against.configSnapshot) {
    return { available: false, reason: "no_snapshot", runId: run.id, againstId: against.id };
  }
  return {
    available: true,
    runId: run.id,
    againstId: against.id,
    ...diffSnapshots(against.configSnapshot, run.configSnapshot),
  };
}
