/**
 * Reparto de los eventos SSE a varios suscriptores (dev-tasks/05, D-05-4).
 * Puro: el `EventSource` lo maneja `src/components/events-provider.tsx`; aquí
 * solo vive el "a quién le toca cada evento", para probarlo sin navegador.
 */

/** Tipos de evento del contrato `specs/001-vocero-core/contracts/sse.md`. */
export const SSE_EVENT_TYPES = [
  "message.new",
  "message.status",
  "conversation.updated",
  "conversation.handoff",
  "lab.run",
  "booking.updated",
  "conversations.bulk",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** Nombre del handler de `useEvents` que atiende cada tipo. */
export const HANDLER_FOR: Record<SseEventType, string> = {
  "message.new": "onMessageNew",
  "message.status": "onMessageStatus",
  "conversation.updated": "onConversationUpdated",
  "conversation.handoff": "onConversationHandoff",
  "lab.run": "onLabRun",
  "booking.updated": "onBookingUpdated",
  "conversations.bulk": "onConversationsBulk",
};

type AnyHandlers = { [name: string]: ((data: never) => void) | undefined } & {
  onReconnect?: () => void;
};

/** El suscriptor se pasa como "ref" para leer siempre sus handlers actuales. */
export type HandlersRef<H> = { readonly current: H };

export function createEventHub<H extends object>() {
  const subs = new Set<HandlersRef<H>>();
  let hadError = false;

  const each = (fn: (h: AnyHandlers) => void) => {
    // Copia: un handler puede desuscribir (o suscribir) durante el reparto.
    for (const ref of [...subs]) {
      try {
        fn(ref.current as unknown as AnyHandlers);
      } catch {
        // Un consumidor que falla no corta el reparto a los demás.
      }
    }
  };

  return {
    subscribe(ref: HandlersRef<H>): () => void {
      subs.add(ref);
      return () => {
        subs.delete(ref);
      };
    },
    get size() {
      return subs.size;
    },
    /** `raw` es el `data` del MessageEvent; malformado → se ignora. */
    dispatch(type: SseEventType, raw: string): void {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      const name = HANDLER_FOR[type];
      each((h) => {
        const fn = h[name] as ((d: unknown) => void) | undefined;
        fn?.(data);
      });
    },
    error(): void {
      hadError = true;
    },
    /**
     * `onopen` del EventSource. Solo tras un error previo es reconexión:
     * la apertura inicial no dispara `onReconnect`.
     */
    open(): void {
      if (!hadError) return;
      hadError = false;
      each((h) => h.onReconnect?.());
    },
  };
}

export type EventHub<H extends object> = ReturnType<typeof createEventHub<H>>;
