"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationCounts,
  ConversationDto,
  ConversationsPage,
} from "@/lib/types";
import {
  DEFAULT_FILTERS,
  applyResolvedIds,
  buildCountsQuery,
  buildIdsQuery,
  buildListQuery,
  countsFromLoaded,
  displayedConversations,
  effectiveFilters,
  filtersToSearch,
  mergeConversations,
  mergeFirstPage,
  pinFirst,
  type InboxFilters,
  type ResolvedIds,
} from "./list-state";
import { claimUnreadSource, publishUnread } from "@/components/unread-store";

/** Ventana para juntar ids de una ráfaga SSE en un solo `?ids=`. */
const RESOLVE_BATCH_MS = 250;
/** Debounce de los contadores tras eventos. */
const COUNTS_DEBOUNCE_MS = 500;
/** 05: reloj de «Ventana por cerrar» (las filas vencen solas, CA-05-08). */
export const CLOSING_TICK_MS = 60_000;

export type InboxListError = "first" | "more" | null;

/**
 * 06 — Lista paginada de la Bandeja: primera página, scroll infinito por
 * `nextCursor`, upsert por eventos vía `?ids=` y contadores de `/counts`.
 * La lógica pura vive en `list-state.ts`.
 */
export function useInboxList({
  viewerId,
  localTeamMode,
  onResolved,
  initialFilters = DEFAULT_FILTERS,
}: {
  viewerId: string;
  /**
   * 020: filtros con que arranca (los de la URL de la página, leídos con
   * `useSearchParams` para que el HTML del servidor ya los pinte).
   */
  initialFilters?: InboxFilters;
  /**
   * Regla de respaldo de `teamMode` si `/counts` no responde (`!owner ||
   * equipo > 1`); se le suma "hay alguna asignada en lo cargado".
   */
  localTeamMode: boolean;
  /** Tras cada `?ids=`: quién volvió y quién ya no es visible. */
  onResolved?: (r: Pick<ResolvedIds, "gone" | "present">) => void;
}) {
  const [filters, setFiltersState] = useState<InboxFilters>(initialFilters);
  const [items, setItems] = useState<ConversationDto[] | null>(null);
  // Filtros (como query string) con que se pidió la primera página cargada:
  // si son los activos, la búsqueda ya la resolvió el servidor.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<InboxListError>(null);
  const [serverCounts, setServerCounts] = useState<ConversationCounts | null>(
    null
  );

  const teamMode =
    serverCounts?.teamMode ??
    (localTeamMode || (items?.some((c) => c.assignedTo !== null) ?? false));
  const active = useMemo(
    () => effectiveFilters(filters, teamMode),
    [filters, teamMode]
  );

  const activeRef = useRef(active);
  activeRef.current = active;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const cursorRef = useRef(nextCursor);
  cursorRef.current = nextCursor;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const viewerRef = useRef(viewerId);
  viewerRef.current = viewerId;

  // Generación de la lista: cada `loadFirst` invalida las páginas en vuelo
  // (filtros viejos, cursor viejo) para que no se mezclen con la nueva.
  const gen = useRef(0);
  const loadingMoreRef = useRef(false);

  const setList = useCallback((next: ConversationDto[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const loadFirst = useCallback(async () => {
    const g = ++gen.current;
    const f = activeRef.current;
    // El cursor viejo es de otros filtros: nadie debe seguirlo mientras llega
    // la primera página nueva.
    cursorRef.current = null;
    setNextCursor(null);
    const res = await fetch(`/api/conversations?${buildListQuery(f)}`).catch(
      () => null
    );
    if (g !== gen.current) return;
    if (!res?.ok) {
      setError("first");
      return;
    }
    const data = (await res.json().catch(() => null)) as ConversationsPage | null;
    if (g !== gen.current) return;
    if (!data?.conversations) {
      setError("first");
      return;
    }
    setError(null);
    setList(mergeConversations([], data.conversations));
    setLoadedKey(buildListQuery(f));
    setNextCursor(data.nextCursor ?? null);
  }, [setList]);

  /**
   * Refresco que NO pierde la posición (alt-tab, reconexión del SSE): pide la
   * página 1 con los filtros activos y la FUSIONA sobre lo cargado
   * (`mergeFirstPage`), conservando las páginas siguientes y su cursor. Si
   * lo cargado es de otros filtros (o aún no hay nada), es un `loadFirst`.
   * Un fallo de red deja la lista como estaba.
   */
  const loadedKeyRef = useRef(loadedKey);
  loadedKeyRef.current = loadedKey;
  const refreshFirst = useCallback(async () => {
    const f = activeRef.current;
    if (itemsRef.current === null || loadedKeyRef.current !== buildListQuery(f)) {
      return loadFirst();
    }
    const g = gen.current;
    const res = await fetch(`/api/conversations?${buildListQuery(f)}`).catch(
      () => null
    );
    if (g !== gen.current || !res?.ok) return;
    const data = (await res.json().catch(() => null)) as ConversationsPage | null;
    if (g !== gen.current || !data?.conversations) return;
    const complete = (data.nextCursor ?? null) === null;
    setError(null);
    setList(mergeFirstPage(itemsRef.current ?? [], data.conversations, complete));
    // Cursor: el de la página más honda cargada sigue valiendo (keyset). Solo
    // si antes TODO cabía (sin cursor) y ahora hay más, se toma el de la 1;
    // lo repetido se descarta al fusionar por id.
    if (complete) setNextCursor(null);
    else if (cursorRef.current === null) setNextCursor(data.nextCursor);
  }, [loadFirst, setList]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    const g = gen.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const f = activeRef.current;
      const res = await fetch(
        `/api/conversations?${buildListQuery(f, { cursor })}`
      ).catch(() => null);
      if (g !== gen.current) return;
      const data = res?.ok
        ? ((await res.json().catch(() => null)) as ConversationsPage | null)
        : null;
      if (g !== gen.current) return;
      if (!data?.conversations) {
        // Lo cargado se queda: el pie ofrece "Reintentar".
        setError("more");
        return;
      }
      setList(mergeConversations(itemsRef.current ?? [], data.conversations));
      setNextCursor(data.nextCursor ?? null);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [setList]);

  // --- Contadores ----------------------------------------------------------
  const countsSeq = useRef(0);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchCounts = useCallback(async () => {
    const seq = ++countsSeq.current;
    const res = await fetch(
      `/api/conversations/counts?${buildCountsQuery(activeRef.current)}`
    ).catch(() => null);
    if (seq !== countsSeq.current) return;
    // 401: sesión revocada → el indicador global manda a /login.
    if (res?.status === 401) publishUnread("unauthorized");
    const data = res?.ok
      ? ((await res.json().catch(() => null)) as ConversationCounts | null)
      : null;
    if (seq !== countsSeq.current) return;
    // 501 (servidor anterior a 06) o error: se cuenta sobre lo cargado.
    setServerCounts(data && typeof data.all === "number" ? data : null);
    // 05: `unreadConversations` no depende de los filtros: es el N del
    // título/favicon/menú de esta pestaña (una sola petición por evento).
    if (data && typeof data.unreadConversations === "number") {
      publishUnread(data.unreadConversations);
    }
  }, []);
  const refreshCounts = useCallback(
    (opts: { now?: boolean } = {}) => {
      if (countsTimer.current) clearTimeout(countsTimer.current);
      if (opts.now) {
        countsTimer.current = null;
        void fetchCounts();
        return;
      }
      countsTimer.current = setTimeout(() => {
        countsTimer.current = null;
        void fetchCounts();
      }, COUNTS_DEBOUNCE_MS);
    },
    [fetchCounts]
  );

  // --- Resolución de ids por eventos ---------------------------------------
  const pendingIds = useRef(new Set<string>());
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushIds = useCallback(async () => {
    resolveTimer.current = null;
    const ids = [...pendingIds.current];
    pendingIds.current.clear();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await fetch(`/api/conversations?${buildIdsQuery(chunk)}`).catch(
        () => null
      );
      // Sin respuesta no se concluye nada: retirar por un error de red
      // cerraría hilos que siguen siendo visibles. Los ids vuelven a la cola
      // y se resuelven con el próximo lote (otro evento, la vuelta de la red
      // o de la pestaña): sin red el SSE puede seguir vivo, así que no habrá
      // `onReconnect` que los rescate.
      const data = res?.ok
        ? ((await res.json().catch(() => null)) as ConversationsPage | null)
        : null;
      if (!data?.conversations) {
        for (const id of chunk) pendingIds.current.add(id);
        continue;
      }
      const r = applyResolvedIds(
        itemsRef.current ?? [],
        chunk,
        data.conversations,
        activeRef.current,
        viewerRef.current
      );
      if (itemsRef.current !== null) setList(r.items);
      onResolvedRef.current?.({ gone: r.gone, present: r.present });
    }
  }, [setList]);
  const resolveIds = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) if (id) pendingIds.current.add(id);
      if (pendingIds.current.size === 0 || resolveTimer.current) return;
      resolveTimer.current = setTimeout(() => void flushIds(), RESOLVE_BATCH_MS);
    },
    [flushIds]
  );

  // Conversación anclada arriba por el enlace `?contact=` (CA-06-05), hasta
  // que se elige otra (`releasePin`).
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  /**
   * Inserta una fila sin pasar por el filtro (enlace profundo `?contact=`);
   * con `pin`, además se pinta arriba de la lista (`pinFirst`).
   */
  const upsert = useCallback(
    (c: ConversationDto, opts: { pin?: boolean } = {}) => {
      setList(mergeConversations(itemsRef.current ?? [], [c]));
      if (opts.pin) setPinnedId(c.id);
    },
    [setList]
  );

  /** Al elegir otra conversación, la del enlace vuelve a su lugar por orden. */
  const releasePin = useCallback((selectedId: string) => {
    setPinnedId((prev) => (prev === selectedId ? prev : null));
  }, []);

  // Mientras la Bandeja está montada, ella es la fuente del N compartido.
  useEffect(() => claimUnreadSource(), []);

  useEffect(
    () => () => {
      if (countsTimer.current) clearTimeout(countsTimer.current);
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
    },
    []
  );

  // Cada cambio de filtros (incluido `teamMode`, que decide si "Mías"
  // filtra) recarga la primera página y los contadores.
  const activeKey = buildListQuery(active);
  useEffect(() => {
    void loadFirst();
    refreshCounts({ now: true });
  }, [activeKey, loadFirst, refreshCounts]);

  const setFilters = useCallback((patch: Partial<InboxFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  // 020 — Los filtros viven en la URL de la página (compartir/recargar). Se
  // REEMPLAZA la entrada del historial (no se apila una por clic) y se
  // conservan las claves ajenas, como el enlace `?contact=`.
  const urlKey = filtersToSearch(filters, new URLSearchParams());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const here = new URLSearchParams(window.location.search);
    const next = filtersToSearch(filters, here);
    if (next === window.location.search) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${next}${window.location.hash}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `urlKey` resume `filters`
  }, [urlKey]);

  // 05 — Con «Ventana por cerrar» activa, cada minuto: las filas que ya
  // pasaron las 24 h salen (espejo con el reloj nuevo), entran las que
  // acaban de cruzar las 22 h (página 1 fusionada) y se corrigen contadores.
  const [clock, setClock] = useState(() => Date.now());
  const closingActive = active.closing;
  useEffect(() => {
    if (!closingActive) return;
    setClock(Date.now());
    const t = setInterval(() => {
      setClock(Date.now());
      void refreshFirst();
      refreshCounts({ now: true });
    }, CLOSING_TICK_MS);
    return () => clearInterval(t);
  }, [closingActive, refreshFirst, refreshCounts]);

  const visible = useMemo(
    () =>
      items
        ? pinFirst(
            displayedConversations(items, loadedKey, active, viewerId, clock),
            pinnedId
          )
        : null,
    [items, loadedKey, active, viewerId, pinnedId, clock]
  );
  const counts = useMemo<ConversationCounts | null>(() => {
    if (serverCounts) return serverCounts;
    if (!items) return null;
    return countsFromLoaded(items, active, viewerId);
  }, [serverCounts, items, active, viewerId]);

  return {
    /** Todo lo cargado (para buscar la abierta o el contacto del enlace). */
    items,
    /**
     * Lo que se pinta: lo cargado dentro del filtro activo, sin volver a
     * filtrar por `q` lo que el servidor ya buscó (`displayedConversations`).
     */
    visible,
    filters,
    active,
    setFilters,
    counts,
    teamMode,
    hasMore: nextCursor !== null,
    loadingMore,
    error,
    loadFirst,
    refreshFirst,
    loadMore,
    resolveIds,
    refreshCounts,
    upsert,
    releasePin,
  };
}
