"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useFollowUpsChanged } from "./follow-up-events";

/** Vuelta del número rojo: barata (una cuenta por índice) y sin SSE (fase B). */
const POLL_MS = 2 * 60_000;

/**
 * 035 — Recordatorios propios vencidos (`GET /api/follow-ups/count`). Se pide
 * al montar, al navegar, cada 2 min, al volver a la pestaña y cuando algo en
 * esta pestaña cambia un recordatorio. Un fallo deja el número como estaba.
 */
export function useOverdueCount(): number {
  const pathname = usePathname();
  const [n, setN] = useState(0);
  const refresh = useCallback(async () => {
    const res = await fetch("/api/follow-ups/count").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as { overdue?: number } | null;
    if (typeof data?.overdue === "number") setN(data.overdue);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useFollowUpsChanged(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );
  return n;
}
