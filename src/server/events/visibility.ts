import { isOwner, type Role } from "@/lib/roles";
import type { SseEvent } from "./bus";

/**
 * ¿Esta conexión SSE debe recibir el evento? (tarea 00, RF-00-03 / T-00-12).
 *
 * Chequeo SÍNCRONO solo por rol: el progreso del Laboratorio (`lab.run`) es
 * del Propietario. Lo usa hoy `/api/events`; la decisión completa con
 * asignación (09) es `decideDelivery`, más abajo.
 *
 * El rol se toma al abrir la conexión: un cambio de rol surte efecto al
 * reconectar (≤ un heartbeat), igual que la baja de un miembro.
 */
export function canReceive(event: SseEvent, viewer: { role: Role }): boolean {
  if (event.type === "lab.run") return isOwner(viewer);
  return true;
}

/**
 * Decisión por evento y por conexión (dev-tasks/09, RF-09-09):
 *
 *   deliver → se envía tal cual.
 *   rewrite → se envía `event` (reducido) en lugar del original.
 *   drop    → no se envía.
 */
export type DeliveryDecision =
  | { kind: "deliver" }
  | { kind: "rewrite"; event: SseEvent }
  | { kind: "drop" };

export type DeliveryDeps = {
  /**
   * ¿El viewer de esta conexión ve la conversación? Inyectado: en la ruta es
   * `(id) => canSeeConversation(orgId, viewer, id)`
   * (`src/server/inbox/visibility.ts`, consulta por PK). Puede lanzar.
   */
  canSee: (conversationId: string) => Promise<boolean>;
};

/**
 * Decide qué hace la conexión de `viewer` con `event`.
 *
 * Propietario: todo se entrega tal cual (sin consultar la BD).
 * Vendedor:
 *   - `lab.run` → drop.
 *   - `message.new` / `message.status` → deliver solo si `canSee(conversationId)`;
 *     si no la ve, o si `canSee` LANZA (BD caída/lenta) → drop. Cerrar por
 *     defecto: el cliente se pone al día con el refetch de `onReconnect` o con
 *     el siguiente `conversation.updated`.
 *   - `conversation.updated` → rewrite SIEMPRE a `{ conversation: { id } }`
 *     (quien perdió una conversación necesita el aviso para refrescar su
 *     lista); sin `id` string → drop.
 *   - `booking.updated` → deliver (solo lleva el id de la cita).
 *
 * Contrato para `/api/events` (lo cablea 09-A):
 *   - Los eventos de UNA conexión se procesan en ORDEN de llegada: una cola de
 *     promesas por conexión (`queue = queue.then(() => decideDelivery(...))
 *     .then(send)`), para que un `message.status` no adelante a su
 *     `message.new` mientras este espera su consulta.
 *   - Nunca rechaza: un error de BD descarta ESE evento y el stream sigue
 *     vivo (la cola jamás queda en estado rechazado).
 */
export async function decideDelivery(
  event: SseEvent,
  viewer: { role: Role },
  deps: DeliveryDeps
): Promise<DeliveryDecision> {
  if (isOwner(viewer)) return { kind: "deliver" };

  switch (event.type) {
    case "lab.run":
      return { kind: "drop" };
    case "message.new":
    case "message.status": {
      try {
        const visible = await deps.canSee(event.data.conversationId);
        return visible ? { kind: "deliver" } : { kind: "drop" };
      } catch {
        return { kind: "drop" };
      }
    }
    case "conversation.updated": {
      const id: unknown = (event.data as { conversation?: { id?: unknown } })
        ?.conversation?.id;
      if (typeof id !== "string" || id === "") return { kind: "drop" };
      return {
        kind: "rewrite",
        event: { type: "conversation.updated", data: { conversation: { id } } },
      };
    }
    case "booking.updated":
      return { kind: "deliver" };
    default:
      // Tipo nuevo sin clasificar: cerrar por defecto hasta decidir su regla.
      return { kind: "drop" };
  }
}
