import { desc, sql } from "drizzle-orm";
import { apiError, parseOptionalBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isAiConfigured } from "@/lib/env";
import { labErrorResponse } from "@/server/lab/errors";
import { computeDeltas, personaHashesOf } from "@/server/lab/history";
import { RunConflictError, startRun } from "@/server/lab/runner";
import { runCreateSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * Historial de corridas con delta de score (FR-033, RF-08-17): el delta se
 * calcula solo contra la corrida `done` anterior con el MISMO conjunto de
 * personas (mismas claves y mismo hash por clave); si hay anteriores pero
 * ninguna comparable → `delta: null` y `deltaNote: "conjunto distinto"`.
 *
 * Columnas EXPLÍCITAS: `config_snapshot` es pesado y jamás viaja en este
 * listado de 50; de él solo se lee `-> 'personas'` (clave + hash).
 */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const runs = await db
    .select({
      id: schema.agentTestRun.id,
      status: schema.agentTestRun.status,
      score: schema.agentTestRun.score,
      error: schema.agentTestRun.error,
      personaKeys: schema.agentTestRun.personaKeys,
      personas: sql<unknown>`${schema.agentTestRun.configSnapshot} -> 'personas'`,
      startedAt: schema.agentTestRun.startedAt,
      finishedAt: schema.agentTestRun.finishedAt,
    })
    .from(schema.agentTestRun)
    .where(scoped(schema.agentTestRun.organizationId, session.organizationId))
    .orderBy(desc(schema.agentTestRun.startedAt))
    .limit(50);

  const withDelta = computeDeltas(
    runs.map(({ personas, ...r }) => ({
      ...r,
      personaKeys: r.personaKeys ?? null,
      personaHashes: personaHashesOf(personas),
    }))
  );
  return Response.json({ runs: withDelta, aiConfigured: isAiConfigured() });
}, { role: "owner" });

/**
 * POST con cuerpo OPCIONAL `{ personaKeys?: string[] }` (1..10 claves únicas;
 * sin cuerpo = todas las activas).
 *   → 202 `{ runId }`
 *   · 409 `ai_not_configured` · 409 `run_in_progress`
 *   · 422 `invalid_body` · 422 `no_personas` · 422 `unknown_persona`
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseOptionalBody(req, runCreateSchema);
  if (!body.ok) return body.response;
  if (!isAiConfigured()) {
    return apiError(
      409,
      "ai_not_configured",
      "Configura tu proveedor de IA para correr el Laboratorio"
    );
  }
  try {
    const runId = await startRun(session.organizationId, body.data.personaKeys);
    return Response.json({ runId }, { status: 202 });
  } catch (err) {
    if (err instanceof RunConflictError) {
      return apiError(
        409,
        "run_in_progress",
        "Ya hay una corrida en curso; espera a que termine"
      );
    }
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
