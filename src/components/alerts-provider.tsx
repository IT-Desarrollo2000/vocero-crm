"use client";

import { createContext, useContext, useEffect } from "react";
import { acquireAlertsCoordinator } from "@/components/alerts-coordinator";
import { installAudioUnlock } from "@/components/alert-sound";
import { useAlertPrefs } from "@/components/use-alert-prefs";
import { useUnreadIndicator } from "@/components/use-unread-indicator";

/**
 * Lo de alertas que corre en TODAS las pestañas (dev-tasks/05), montado en
 * `AppShell` dentro de `ViewerProvider` y `EventsProvider`:
 *
 * - coordinador entre pestañas (líder, presencia, dedupe compartido);
 * - desbloqueo de audio en el primer gesto de ESTA pestaña;
 * - `(N)` en el título + punto en el favicon, y el mismo N para el badge del
 *   menú vía `useUnreadCount()` (así no se piden los contadores dos veces).
 *
 * Las notificaciones las decide `useInboxAlerts()` (lo monta 05-inbox).
 */

const UnreadCountContext = createContext<number | null>(null);

export function AlertsProvider({ children }: { children: React.ReactNode }) {
  const [prefs] = useAlertPrefs();
  const unread = useUnreadIndicator(prefs.tabCounter);

  useEffect(() => acquireAlertsCoordinator(), []);
  useEffect(() => installAudioUnlock(), []);

  return (
    <UnreadCountContext.Provider value={unread}>{children}</UnreadCountContext.Provider>
  );
}

/**
 * Conversaciones con no leídos (D-05-1) que ve quien mira; `null` mientras
 * carga o fuera del proveedor. Es el número del título y del badge del menú.
 */
export function useUnreadCount(): number | null {
  return useContext(UnreadCountContext);
}
