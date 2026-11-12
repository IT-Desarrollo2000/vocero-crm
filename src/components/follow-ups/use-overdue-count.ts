"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { FollowUpCountsDto } from "@/lib/notifications";
import { useFollowUpsChanged } from "./follow-up-events";

/** Vuelta de respaldo: barata (una cuenta por índice). */
const POLL_MS = 2 * 60_000;

/**
 * 035 — Recordatorios PROPIOS: vencidos y de hoy (`GET /api/follow-ups/count`
 * → `{ overdue, today }`). Se pide al montar, al navegar, cada 2 min, al
 * volver a la pestaña y cuando cambia un recordatorio: en esta pestaña o
 * (fase B) por SSE `follow_ups.changed` aunque lo haya tocado el
 * Propietario — el proveedor de avisos lo reenvía como el mismo evento de
 * ventana, así no hay dos suscripciones. Un fallo deja los números como
 * estaban; `null` mientras carga.
 */
export function useFollowUpCounts(): FollowUpCountsDto | null {
  const pathname = usePathname();
  const [counts, setCounts] = useState<FollowUpCountsDto | null>(null);
  const refresh = useCallback(async () => {
    const res = await fetch("/api/follow-ups/count").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as Partial<FollowUpCountsDto> | null;
    if (typeof data?.overdue === "number") {
      setCounts({ overdue: data.overdue, today: typeof data.today === "number" ? data.today : data.overdue });
    }
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
  return counts;
}

/** El número rojo junto a «Seguimiento». */
export function useOverdueCount(): number {
  return useFollowUpCounts()?.overdue ?? 0;
}
