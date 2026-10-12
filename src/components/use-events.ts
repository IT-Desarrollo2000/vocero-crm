"use client";

import { useEffect, useRef } from "react";
import { createEventHub } from "@/lib/event-hub";
import { connectEventSource, useEventHub } from "@/components/events-provider";

export type EventHandlers = {
  onMessageNew?: (data: { conversationId: string; message: unknown }) => void;
  onMessageStatus?: (data: {
    conversationId: string;
    messageId: string;
    status: string;
    /** Motivo, presente solo cuando status = "failed". */
    error?: string | null;
  }) => void;
  onConversationUpdated?: (data: { conversation: unknown }) => void;
  /**
   * 05/02-0 — Una conversación pasó a necesitar humano. `reason` incluye
   * `manual_reply` (el dueño contestó desde el teléfono): no alertar por ese.
   */
  onConversationHandoff?: (data: {
    conversationId: string;
    reason: string;
    handoffAt: string;
  }) => void;
  onLabRun?: (data: {
    runId: string;
    status: string;
    progress: { done: number; total: number };
    score?: number | null;
  }) => void;
  /** 015 — Algo cambió en la agenda (también cuando agenda la IA). */
  onBookingUpdated?: (data: { bookingId: string }) => void;
  /** Se llama tras RECONECTAR (no en la conexión inicial): catch-up con refetch. */
  onReconnect?: () => void;
};

/**
 * Suscripción SSE de la bandeja (contrato sse.md). Dentro de `AppShell`
 * comparte el ÚNICO `EventSource` de la pestaña (`EventsProvider`, D-05-4);
 * fuera de él abre su propia conexión, como antes. EventSource reconecta
 * solo; el servidor no garantiza replay, así que al reconectar el consumidor
 * debe refetch con `since=` (onReconnect).
 */
export function useEvents(handlers: EventHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const shared = useEventHub();

  useEffect(() => {
    if (shared) return shared.subscribe(handlersRef);
    // Sin proveedor: conexión propia (mismo comportamiento que antes de 05).
    const hub = createEventHub<EventHandlers>();
    const unsubscribe = hub.subscribe(handlersRef);
    const close = connectEventSource(hub);
    return () => {
      unsubscribe();
      close();
    };
  }, [shared]);
}
