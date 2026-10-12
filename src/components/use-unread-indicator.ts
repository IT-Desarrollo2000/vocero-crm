"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { applyTitleCount, unreadFromCounts } from "@/lib/alerts";
import { createFaviconBadge } from "@/components/favicon-badge";
import { useEvents } from "@/components/use-events";
import {
  getUnread,
  hasExternalUnreadSource,
  publishUnread,
  subscribeUnread,
} from "@/components/unread-store";

/**
 * `(N)` en el título y punto en el favicon (RF-05-07/08), en TODAS las
 * pestañas. N = conversaciones con no leídos (D-05-1), de
 * `GET /api/conversations/counts` (06) → `unreadConversations`. Si `counts`
 * falla, el número se queda como estaba: NO se cae a la lista completa (con la
 * BD sufriendo, eso multiplicaría la carga).
 *
 * Se refresca al montar, con `message.new`/`conversation.updated` (debounce
 * 500 ms), al reconectar el SSE y al volver a la pestaña — salvo mientras la
 * Bandeja es la fuente (`unread-store.ts`): ella ya pide `/counts` en cada
 * evento y publica el número. Al reconectar NO se notifica nada retroactivo:
 * solo se corrige el número. Un 401 (sesión revocada) manda a /login.
 */

const DEBOUNCE_MS = 500;

/** N actual de no leídos; `"unauthorized"` ante 401; `null` si no se pudo saber. */
export async function fetchUnreadConversations(): Promise<number | "unauthorized" | null> {
  const counts = await fetch("/api/conversations/counts").catch(() => null);
  if (counts?.status === 401) return "unauthorized";
  if (!counts?.ok) return null;
  return unreadFromCounts(await counts.json().catch(() => null));
}

/**
 * @param enabled preferencia «contador en pestaña»: apagada = título y
 *   favicon originales (el número se sigue calculando para el badge).
 * @returns N (para compartirlo con el badge del menú), `null` = aún no se sabe.
 */
export function useUnreadIndicator(enabled: boolean): number | null {
  const pathname = usePathname();
  const router = useRouter();
  const stored = useSyncExternalStore(subscribeUnread, getUnread, () => null);
  const count = typeof stored === "number" ? stored : null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = enabled && count !== null ? count : 0;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const refetch = useCallback(async () => {
    const n = await fetchUnreadConversations();
    if (n !== null) publishUnread(n);
  }, []);

  // Sesión revocada (dado de baja, contraseña restablecida): a la entrada,
  // en vez de dejar la pantalla viva contra una API que ya no responde.
  // El store es de módulo (sobrevive al desmontaje): se limpia al redirigir,
  // o el siguiente inicio de sesión en la misma pestaña rebotaría a /login.
  useEffect(() => {
    if (stored !== "unauthorized") return;
    publishUnread(null);
    router.replace("/login");
  }, [stored, router]);

  const schedule = useCallback(() => {
    if (hasExternalUnreadSource()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void refetch();
    }, DEBOUNCE_MS);
  }, [refetch]);

  useEffect(() => {
    if (!hasExternalUnreadSource()) void refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !hasExternalUnreadSource()) {
        void refetch();
      }
    };
    // La red vuelve: sin red el SSE puede seguir abierto y `/counts` falló.
    const onOnline = () => {
      if (!hasExternalUnreadSource()) void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refetch]);

  useEvents({
    onMessageNew: schedule,
    onConversationUpdated: schedule,
    onReconnect: () => {
      if (!hasExternalUnreadSource()) void refetch();
    },
  });

  // Favicon: un solo controlador por pestaña.
  const [badge] = useState(() =>
    typeof document === "undefined" ? null : createFaviconBadge(document)
  );

  // Título + favicon; se reaplica al navegar (Next reescribe el `<title>` y
  // puede re-montar los `<link rel="icon">`) y con cada cambio del `<head>`.
  useEffect(() => {
    applyTitleCount(document, shown);
    void badge?.set(shown > 0);
  }, [shown, pathname, badge]);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      applyTitleCount(document, shownRef.current);
      // Un `<link rel=icon>` nuevo de Next llega sin punto: re-ponerlo
      // (renderizado en caché, barato). Solo atributos NO se observan, así
      // que cambiar el `href` aquí no re-dispara el observador.
      if (shownRef.current > 0) void badge?.set(true);
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [badge]);

  // Al desmontar (cerrar sesión): título y favicon originales.
  useEffect(
    () => () => {
      applyTitleCount(document, 0);
      badge?.restore();
      // Cerrar sesión: el N de esta cuenta no debe verlo la siguiente.
      publishUnread(null);
    },
    [badge]
  );

  return count;
}
