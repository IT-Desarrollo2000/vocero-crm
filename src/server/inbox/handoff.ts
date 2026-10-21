import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { toHandoffNote } from "@/server/ai/handoff";
import { openAwaitingSql } from "@/server/inbox/awaiting";

/**
 * Puerta ÚNICA de escalamiento a humano (contrato 05/02-0).
 *
 * Escalar y registrar el escalamiento son la misma operación: el UPDATE de
 * `conversation` es condicional (`handoff_at IS NULL`) y, si hubo transición,
 * en la MISMA transacción se inserta el evento `opened` en
 * `conversation_handoff_event` (bitácora append-only de 02). Tras el commit se
 * publica `conversation.handoff` (alertas de 05) y `conversation.updated`.
 *
 * Idempotente: con un handoff ya abierto no escribe ni publica nada — el
 * primer motivo gana (antes, un `window_closed` del farewell escribía
 * "ventana" y enseguida "modelo" lo pisaba).
 *
 * Laboratorio (`is_test`): solo el UPDATE (el runner lo lee para cortar el
 * guion); cero filas de bitácora y cero eventos SSE.
 *
 * Un test de vigilancia (`handoff-event-guard.test.ts`) falla si otra parte
 * del código inserta en esa tabla, o si alguien la actualiza o borra.
 */

export type HandoffReason = (typeof schema.HANDOFF_REASONS)[number];
export type HandoffSource = (typeof schema.HANDOFF_SOURCES)[number];

export type MarkHandoffInput = {
  organizationId: string;
  conversationId: string;
  reason: HandoffReason;
  /** Explicación libre; se recorta con `toHandoffNote` (vacía → null). */
  note?: string | null;
  /** Quién escala. `migracion` es exclusivo de la siembra SQL. */
  source: Exclude<HandoffSource, "migracion">;
  /** true → además apaga la IA (`ai_enabled = false`); false → no la toca. */
  pauseAi: boolean;
  /** Usuario del CRM que lo provocó, si lo hubo (NULL = agente/bot/teléfono). */
  actorUserId?: string | null;
};

export type MarkHandoffResult =
  | { applied: true; handoffAt: Date; isTest: boolean }
  | { applied: false };

export async function markHandoff(
  input: MarkHandoffInput
): Promise<MarkHandoffResult> {
  const db = getDb();
  const now = new Date();
  const note = toHandoffNote(input.note);

  const result = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.conversation)
      .set({
        ...(input.pauseAi ? { aiEnabled: false } : {}),
        handoffAt: now,
        handoffReason: input.reason,
        handoffNote: note,
        // 026: el cliente espera a la persona desde ahora (si no esperaba ya
        // desde antes). El eco del teléfono (`manual_reply`) no: ES una
        // respuesta humana.
        ...(input.reason !== "manual_reply"
          ? { awaitingSince: openAwaitingSql(now) }
          : {}),
        updatedAt: now,
      })
      .where(
        scoped(
          schema.conversation.organizationId,
          input.organizationId,
          eq(schema.conversation.id, input.conversationId),
          sql`${schema.conversation.handoffAt} is null`
        )
      )
      .returning({
        id: schema.conversation.id,
        isTest: schema.conversation.isTest,
      });
    const row = updated[0];
    if (!row) return { applied: false as const };

    const isTest = row.isTest === true;
    if (!isTest) {
      await tx.insert(schema.conversationHandoffEvent).values({
        id: newId("handoffEvent"),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        kind: "opened",
        reason: input.reason,
        note,
        source: input.source,
        actorUserId: input.actorUserId ?? null,
        approximate: false,
        createdAt: now,
      });
    }
    return { applied: true as const, handoffAt: now, isTest };
  });

  // Publicar SIEMPRE tras el commit (contrato sse.md). El Laboratorio no
  // publica: sus conversaciones jamás alertan ni mueven contadores.
  if (result.applied && !result.isTest) {
    publish(input.organizationId, {
      type: "conversation.handoff",
      data: {
        conversationId: input.conversationId,
        reason: input.reason,
        handoffAt: result.handoffAt.toISOString(),
      },
    });
    // 09 (RF-09-09): solo el id; motivo y nota se leen por la API con su vista.
    publish(input.organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: input.conversationId } },
    });
  }
  return result;
}
