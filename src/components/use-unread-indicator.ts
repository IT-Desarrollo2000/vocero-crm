"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { applyTitleCount, unreadFromCounts, unreadFromList } from "@/lib/alerts";
import { createFaviconBadge } from "@/components/favicon-badge";
import { useEvents } from "@/components/use-events";

/**
 * `(N)` en el título y punto en el favicon (RF-05-07/08), en TODAS las
 * pestañas. N = conversaciones con no leídos (D-05-1), de
 * `GET /api/conversations/counts` (06) → `unreadConversations`; mientras
 * `counts` no exista (o falle), se cuenta sobre la lista completa.
 *
 * Se refresca al montar, con `message.new`/`conversation.updated` (debounce
 * 500 ms), al reconectar el SSE y al volver a la pestaña. Al reconectar NO se
 * notifica nada retroactivo: solo se corrige el número.
 */

const DEBOUNCE_MS = 500;

/** N actual de no leídos, o `null` si no se pudo saber. */
export async function fetchUnreadConversations(): Promise<number | null> {
  const counts = await fetch("/api/conversations/counts").catch(() => null);
  if (counts?.ok) {
    const n = unreadFromCounts(await counts.json().catch(() => null));
    if (n !== null) return n;
  }
  // 401 (sesión revocada) lo atiende el menú; aquí solo no se toca nada.
  if (counts?.status === 401) return null;
  const list = await fetch("/api/conversations").catch(() => null);
  if (!list?.ok) return null;
  return unreadFromList(await list.json().catch(() => null));
}

/**
 * @param enabled preferencia «contador en pestaña»: apagada = título y
 *   favicon originales (el número se sigue calculando para el badge).
 * @returns N (para compartirlo con el badge del menú), `null` = aún no se sabe.
 */
export function useUnreadIndicator(enabled: boolean): number | null {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = enabled && count !== null ? count : 0;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const refetch = useCallback(async () => {
    const n = await fetchUnreadConversations();
    if (n !== null) setCount(n);
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void refetch();
    }, DEBOUNCE_MS);
  }, [refetch]);

  useEffect(() => {
    void refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refetch]);

  useEvents({
    onMessageNew: schedule,
    onConversationUpdated: schedule,
    onReconnect: () => void refetch(),
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
    },
    [badge]
  );

  return count;
}
