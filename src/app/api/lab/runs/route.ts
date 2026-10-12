import { desc } from "drizzle-orm";
import { apiError, parseOptionalBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isAiConfigured } from "@/lib/env";
import {
  LAB_DELTA_NOTE_DIFFERENT_SET,
  type LabRunSummaryDto,
} from "@/lib/lab";
import { samePersonaSet } from "@/server/lab/history";
import { RunConflictError, startRun } from "@/server/lab/runner";
import { runCreateSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * Historial de corridas con delta de score (FR-033, RF-08-17): el delta se
 * calcula solo contra la corrida `done` anterior con el MISMO conjunto de
 * personas; si hay anteriores pero ninguna comparable → `delta: null` y
 * `deltaNote: "conjunto distinto"`.
 *
 * Columnas EXPLÍCITAS: `config_snapshot` es pesado y jamás viaja en este
 * listado de 50. (08-A: sumar el hash por persona con
 * `config_snapshot -> 'personas'` para `samePersonaSet`.)
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
      startedAt: schema.agentTestRun.startedAt,
      finishedAt: schema.agentTestRun.finishedAt,
    })
    .from(schema.agentTestRun)
    .where(scoped(schema.agentTestRun.organizationId, session.organizationId))
    .orderBy(desc(schema.agentTestRun.startedAt))
    .limit(50);

  const withDelta = runs.map((run, i): LabRunSummaryDto => {
    const previous = runs
      .slice(i + 1)
      .filter((r) => r.status === "done" && r.score !== null);
    const prev = previous.find((r) =>
      samePersonaSet(
        { personaKeys: run.personaKeys ?? null },
        { personaKeys: r.personaKeys ?? null }
      )
    );
    const comparable =
      run.status === "done" && run.score !== null && prev?.score != null;
    return {
      id: run.id,
      status: run.status,
      score: run.score,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      personaKeys: run.personaKeys ?? null,
      delta: comparable ? run.score! - prev!.score! : null,
      deltaAgainst: comparable ? prev!.id : null,
      deltaNote:
        run.status === "done" &&
        run.score !== null &&
        !prev &&
        previous.length > 0
          ? LAB_DELTA_NOTE_DIFFERENT_SET
          : null,
    };
  });
  return Response.json({ runs: withDelta, aiConfigured: isAiConfigured() });
}, { role: "owner" });

/**
 * POST con cuerpo OPCIONAL `{ personaKeys?: string[] }` (1..10 claves únicas;
 * sin cuerpo = todas las activas).
 *   → 202 `{ runId }`
 *   · 409 `ai_not_configured` · 409 `run_in_progress`
 *   · 422 `invalid_body` · 422 `no_personas` · 422 `unknown_persona` (08-A)
 *   · hoy 501 `not_implemented` si llega `personaKeys` (la selección la
 *     cablea 08-A en `startRun`).
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
  if (body.data.personaKeys) {
    return apiError(
      501,
      "not_implemented",
      "Elegir personas por corrida: pendiente (tarea 08-A)"
    );
  }
  try {
    const runId = await startRun(session.organizationId);
    return Response.json({ runId }, { status: 202 });
  } catch (err) {
    if (err instanceof RunConflictError) {
      return apiError(
        409,
        "run_in_progress",
        "Ya hay una corrida en curso; espera a que termine"
      );
    }
    throw err;
  }
}, { role: "owner" });
