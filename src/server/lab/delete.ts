import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * Eliminar una evaluación (corrida) del Laboratorio con todo lo que generó:
 * sus casos (cascada desde el run), sus conversaciones de prueba (y con ellas
 * mensajes, huecos ofrecidos y demás en cascada) y las citas de prueba que
 * colgaban de esas conversaciones.
 *
 * Lo que NO se borra: los contactos sintéticos del Laboratorio, que el runner
 * reutiliza entre corridas.
 *
 * Una corrida `running` no se elimina: el índice parcial UNIQUE
 * `test_run_org_running_uq` es el candado de concurrencia y el runner sigue
 * escribiendo sobre ella. No hay cancelación — se espera a que termine.
 */

export type DeleteRunResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "run_in_progress" };

export async function deleteTestRun(
  organizationId: string,
  runId: string
): Promise<DeleteRunResult> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const runs = await tx
      .select({ id: schema.agentTestRun.id, status: schema.agentTestRun.status })
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
    if (!run) return { ok: false as const, reason: "not_found" as const };
    if (run.status === "running") {
      return { ok: false as const, reason: "run_in_progress" as const };
    }

    // Se leen ANTES de borrar el run: los casos se van con él en cascada.
    const cases = await tx
      .select({ conversationId: schema.agentTestCase.conversationId })
      .from(schema.agentTestCase)
      .where(
        scoped(
          schema.agentTestCase.organizationId,
          organizationId,
          and(
            eq(schema.agentTestCase.runId, runId),
            isNotNull(schema.agentTestCase.conversationId)
          )
        )
      );
    const conversationIds = cases
      .map((c) => c.conversationId)
      .filter((id): id is string => Boolean(id));

    // Condicionado a no-running: si otra petición lo borró entre el SELECT y
    // aquí, 0 filas → not_found (un run terminado jamás vuelve a running).
    const deleted = await tx
      .delete(schema.agentTestRun)
      .where(
        scoped(
          schema.agentTestRun.organizationId,
          organizationId,
          eq(schema.agentTestRun.id, runId),
          ne(schema.agentTestRun.status, "running")
        )
      )
      .returning({ id: schema.agentTestRun.id });
    if (!deleted[0]) return { ok: false as const, reason: "not_found" as const };

    // inArray con lista vacía no es SQL válido: corrida fallida sin casos.
    if (conversationIds.length > 0) {
      await tx
        .delete(schema.booking)
        .where(
          scoped(
            schema.booking.organizationId,
            organizationId,
            eq(schema.booking.isTest, true),
            inArray(schema.booking.conversationId, conversationIds)
          )
        );
      await tx
        .delete(schema.conversation)
        .where(
          scoped(
            schema.conversation.organizationId,
            organizationId,
            eq(schema.conversation.isTest, true),
            inArray(schema.conversation.id, conversationIds)
          )
        );
    }

    return { ok: true as const };
  });
}
