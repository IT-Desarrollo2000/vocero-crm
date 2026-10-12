import { asc, eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { deleteTestRun } from "@/server/lab/delete";
import { legacyPersonaLabel } from "@/server/lab/personas";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const db = getDb();
  // Columnas explícitas: `config_snapshot` solo lo lee el diff.
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
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        session.organizationId,
        eq(schema.agentTestRun.id, id)
      )
    )
    .limit(1);
  const run = runs[0];
  if (!run) return apiError(404, "not_found", "Corrida no encontrada");

  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(
      scoped(
        schema.agentTestCase.organizationId,
        session.organizationId,
        eq(schema.agentTestCase.runId, id)
      )
    )
    .orderBy(asc(schema.agentTestCase.createdAt));

  return Response.json({
    run: {
      id: run.id,
      status: run.status,
      score: run.score,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      // 08 — aditivo: conjunto de la corrida (`null` = anterior a 08).
      personaKeys: run.personaKeys ?? null,
    },
    cases: cases.map((c) => ({
      id: c.id,
      persona: c.persona,
      // 08 — la persona tal como corrió; respaldo para corridas viejas.
      personaLabel: c.personaSnapshot?.name ?? legacyPersonaLabel(c.persona),
      personaSnapshot: c.personaSnapshot ?? null,
      status: c.status,
      veredicto: c.veredicto,
      hallazgos: c.hallazgos ?? [],
      transcript: c.transcript ?? [],
      conversationId: c.conversationId,
      // 04 — aditivo: chequeo determinista de la ficha (`null` si no aplica).
      fichaCheck: c.fichaCheck ?? null,
    })),
  });
}, { role: "owner" });

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const result = await deleteTestRun(session.organizationId, id);
  if (!result.ok) {
    if (result.reason === "run_in_progress") {
      return apiError(
        409,
        "run_in_progress",
        "No se puede eliminar una evaluación en curso"
      );
    }
    return apiError(404, "not_found", "Corrida no encontrada");
  }
  return Response.json({ deleted: true });
}, { role: "owner" });
