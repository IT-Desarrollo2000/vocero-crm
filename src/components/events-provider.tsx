"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { createEventHub, SSE_EVENT_TYPES, type EventHub } from "@/lib/event-hub";
import type { EventHandlers } from "@/components/use-events";

/**
 * UN solo `EventSource` por pestaña (dev-tasks/05, D-05-4). Antes cada
 * `useEvents` abría su conexión (menú + Bandeja + agenda + Laboratorio +
 * alertas); ahora todos se suscriben a este proveedor, montado en `AppShell`.
 *
 * La reconexión la hace el propio EventSource; el servidor no garantiza
 * replay, así que tras reconectar se avisa `onReconnect` a cada suscriptor
 * para que haga su catch-up con refetch (contrato sse.md).
 */
const EventsContext = createContext<EventHub<EventHandlers> | null>(null);

/** Conecta un hub a un `EventSource` nuevo; devuelve cómo cerrarlo. */
export function connectEventSource(
  hub: EventHub<EventHandlers>,
  url = "/api/events"
): () => void {
  const source = new EventSource(url);
  for (const type of SSE_EVENT_TYPES) {
    source.addEventListener(type, (ev) => {
      hub.dispatch(type, String((ev as MessageEvent).data));
    });
  }
  source.onerror = () => hub.error();
  source.onopen = () => hub.open();
  return () => source.close();
}

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const [hub] = useState(() => createEventHub<EventHandlers>());

  useEffect(() => connectEventSource(hub), [hub]);

  return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** El hub compartido, o `null` fuera del proveedor. */
export function useEventHub(): EventHub<EventHandlers> | null {
  return useContext(EventsContext);
}
