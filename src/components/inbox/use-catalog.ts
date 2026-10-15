"use client";

import { useCallback, useRef, useState } from "react";
import type { CatalogDto } from "@/lib/catalog";

/**
 * 019 — Catálogo para el botón Catálogo del compositor (FR-931). Se pide la
 * primera vez que se abre el panel y queda en caché mientras viva el
 * compositor; con error, el panel ofrece reintentar (`reload`).
 */
export function useCatalog(): {
  catalog: CatalogDto | null;
  loading: boolean;
  error: string | null;
  /** Carga si aún no hay catálogo (o `force`). */
  load: (force?: boolean) => Promise<void>;
} {
  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<CatalogDto | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async (force = false) => {
    if ((cache.current && !force) || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    const res = await fetch("/api/catalog").catch(() => null);
    const data = res?.ok
      ? ((await res.json().catch(() => null)) as CatalogDto | null)
      : null;
    inflight.current = false;
    setLoading(false);
    if (!data || !Array.isArray(data.products)) {
      setError(res ? "No se pudo cargar el catálogo" : "Sin conexión con el servidor");
      return;
    }
    cache.current = data;
    setCatalog(data);
  }, []);

  return { catalog, loading, error, load };
}
