import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";

/**
 * 026 — Escrituras de `conversation.awaiting_since` (desde cuándo el cliente
 * espera respuesta). Las lecturas puras viven en `src/lib/awaiting.ts`.
 *
 * Los instantes viajan como texto `::timestamp` (UTC, como los guarda
 * Drizzle): un `Date` viajaría como timestamptz y Postgres lo convertiría con
 * la zona de la sesión.
 */

const C = schema.conversation;

/** Instante como `timestamp` sin zona (UTC). */
export function tsUtc(d: Date): SQL {
  return sql`${d.toISOString()}::timestamp`;
}

/**
 * Un entrante (o algo equivalente: escalamiento, lead externo) abre la
 * espera si estaba cerrada. Si ya esperaba, la espera NO se mueve: cuenta
 * desde el primer mensaje sin contestar.
 */
export function openAwaitingSql(at: Date): SQL {
  return sql`coalesce(${C.awaitingSince}, ${tsUtc(at)})`;
}

/**
 * Un saliente que atiende cierra la espera… salvo que el cliente haya
 * escrito DESPUÉS de que empezó el envío (carrera entrante/saliente): ese
 * mensaje sigue sin contestar, así que la espera queda abierta desde él (o
 * desde antes, si ya estaba abierta).
 *
 * `startedAt` = cuándo empezó el envío (o el `wa_timestamp` del eco del
 * teléfono).
 */
export function closeAwaitingSql(startedAt: Date): SQL {
  return sql`CASE WHEN ${C.lastInboundAt} > ${tsUtc(startedAt)} THEN coalesce(${C.awaitingSince}, ${C.lastInboundAt}) ELSE NULL END`;
}

/**
 * Saliente de la IA o del bot externo: atiende solo si NO hay escalamiento
 * abierto. Un bot que escala (`/api/bot/handoff`) y luego se despide por
 * `/api/bot/messages` no atendió al cliente: lo dejó esperando a la persona.
 * (El agente propio manda su despedida ANTES de `markHandoff`, así que la
 * cierra y el escalamiento la vuelve a abrir.)
 */
export function closeAwaitingByAiSql(startedAt: Date): SQL {
  return sql`CASE WHEN ${C.handoffAt} IS NOT NULL THEN ${C.awaitingSince} ELSE ${closeAwaitingSql(startedAt)} END`;
}
