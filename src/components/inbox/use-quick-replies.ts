"use client";

import { useCallback, useEffect, useState } from "react";
import type { QuickReplyDto } from "@/lib/types";

/**
 * 09 — Catálogo de respuestas rápidas para el compositor. Se pide una vez y
 * se recarga al abrir el selector `/` (alguien pudo editarlo en Ajustes). Si
 * el GET falla (o el servidor aún no lo implementa) la lista queda vacía y se
 * escribe normal: nunca bloquea el envío.
 *
 * 029: `canCreate` (del mismo GET) decide si el compositor ofrece «+ Nueva
 * respuesta rápida» y «Guardar como respuesta rápida». false hasta cargar.
 */
export function useQuickReplies(): {
  quickReplies: QuickReplyDto[];
  canCreate: boolean;
  reload: () => Promise<void>;
} {
  const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
  const [canCreate, setCanCreate] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch("/api/quick-replies").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as {
      quickReplies?: QuickReplyDto[];
      canCreate?: boolean;
    } | null;
    if (Array.isArray(data?.quickReplies)) setQuickReplies(data.quickReplies);
    if (typeof data?.canCreate === "boolean") setCanCreate(data.canCreate);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { quickReplies, canCreate, reload };
}
