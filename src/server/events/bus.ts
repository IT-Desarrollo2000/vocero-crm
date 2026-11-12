import { EventEmitter } from "node:events";

/**
 * Bus de eventos in-process por organización (contrato sse.md).
 * Publicar SIEMPRE después del commit de BD. Una instancia = un proceso,
 * así que un EventEmitter es suficiente (sin colas externas — Constitución II).
 */

export type SseEvent =
  | { type: "message.new"; data: { conversationId: string; message: unknown } }
  | {
      type: "message.status";
      data: {
        conversationId: string;
        messageId: string;
        status: string;
        /** Motivo del fallo, presente solo cuando status = "failed". */
        error?: string | null;
      };
    }
  /**
   * 09 (RF-09-09): SOLO el id — "algo cambió, refetchea con tu vista". Nada
   * de nombre, teléfono, nota de handoff ni responsable: viaja a todos los
   * roles y el cliente ya ignoraba el payload.
   */
  | { type: "conversation.updated"; data: { conversation: { id: string } } }
  /**
   * 05/02-0: una conversación PASÓ a necesitar humano (transición de
   * `handoff_at` de NULL a una fecha). Lo publica solo `markHandoff`
   * (`src/server/inbox/handoff.ts`), nunca para `is_test`. Payload mínimo:
   * nombre, teléfono y nota se piden por la API con la vista del usuario.
   * `reason` es el catálogo de `conversation.handoffReason` (incluye
   * `manual_reply`; el cliente decide no alertar por ese).
   */
  | {
      type: "conversation.handoff";
      data: { conversationId: string; reason: string; handoffAt: string };
    }
  /** 015 — algo cambió en la agenda: la pantalla de Citas se refresca sola. */
  | { type: "booking.updated"; data: { bookingId: string } }
  /**
   * 022 — Archivo masivo o automático: UN evento por operación, SIN ids ni
   * cuántas: "recarga la lista y los contadores con tu vista". Viaja a todos
   * los roles; el cliente recarga la primera página (no fusiona).
   */
  | { type: "conversations.bulk"; data: { reason: "bulk" | "auto" } }
  /**
   * 035 B — Cambió la campana de UNA persona: llegó un aviso (`new`, con el
   * DTO para el aviso emergente) o se leyeron (`read`, con los ids; `all` =
   * todos). Solo lo recibe `userId` (`canReceive`), ni siquiera el
   * Propietario.
   */
  | {
      type: "notification.changed";
      data: {
        userId: string;
        reason: "new" | "read";
        notification?: unknown;
        ids?: string[];
        all?: boolean;
      };
    }
  /**
   * 035 B — Cambiaron recordatorios de estas personas (crear, hecho,
   * posponer): su número rojo y la línea de la Bandeja se refrescan aunque lo
   * haya cambiado el Propietario. Solo lo reciben los `userIds`.
   */
  | { type: "follow_ups.changed"; data: { userIds: string[] } }
  | {
      type: "lab.run";
      data: {
        runId: string;
        status: string;
        progress: { done: number; total: number };
        score?: number | null;
      };
    };

const globalForBus = globalThis as unknown as { __voceroBus?: EventEmitter };

function getBus(): EventEmitter {
  if (!globalForBus.__voceroBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    globalForBus.__voceroBus = bus;
  }
  return globalForBus.__voceroBus;
}

export function publish(organizationId: string, event: SseEvent): void {
  getBus().emit(`org:${organizationId}`, event);
}

export function subscribe(
  organizationId: string,
  listener: (event: SseEvent) => void
): () => void {
  const bus = getBus();
  const channel = `org:${organizationId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}
