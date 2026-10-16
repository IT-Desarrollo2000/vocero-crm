"use client";

import { useEffect, useRef, useState } from "react";
import {
  Hourglass,
  PauseCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import type {
  ConversationCounts,
  ConversationDto,
  InboxOrigin,
  InboxView,
} from "@/lib/types";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { ChannelBadge } from "@/components/channel-badge";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { useStages } from "@/components/use-stages";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import { stageColorByName } from "@/lib/stage-colors";
import { closingRemainingMs } from "@/lib/closing-window";
import {
  assigneeLabel,
  formatRemaining,
  formatTime,
  initials,
  previewText,
} from "./helpers";
import {
  clearPanelFilters,
  hasActiveFilters,
  panelFilterCount,
  type InboxFilters,
} from "./list-state";
import { EtiquetaDeOrigen } from "@/components/anuncio-origen";
import { CLOSING_TICK_MS, type InboxListError } from "./use-inbox-list";
import { AlertsBanner } from "./alerts-banner";

/** Pausa de la búsqueda antes de pedirla al servidor. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 09 — Responsable en la fila. Al Propietario le dice quién la atiende (con
 * sus iniciales); al Vendedor, "Tuya" o "Sin asignar" (no ve otras).
 */
function AssigneeTag({
  c,
  viewerId,
  owner,
}: {
  c: ConversationDto;
  viewerId: string;
  owner: boolean;
}) {
  const { kind, label } = assigneeLabel(c, viewerId);
  if (kind === "none") {
    return (
      <span className="ml-auto inline-flex shrink-0 items-center rounded-full border border-dashed px-2 py-0.5 text-[11px] text-text-3">
        Sin asignar
      </span>
    );
  }
  const name = c.assignedTo?.name ?? label;
  return (
    <span
      title={kind === "mine" ? "La atiendes tú" : `La atiende ${name}`}
      className={cn(
        "ml-auto inline-flex min-w-0 shrink items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]",
        kind === "mine"
          ? "border-brand-soft bg-brand-tint text-brand-text"
          : "bg-secondary text-text-2"
      )}
    >
      <span
        aria-hidden
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-background text-[8.5px] font-semibold"
      >
        {initials(name)}
      </span>
      <span className="truncate">{owner && kind === "other" ? name : label}</span>
    </span>
  );
}

function EmptyState({ onSeeded }: { onSeeded: () => void }) {
  const [seeding, setSeeding] = useState(false);
  const [failed, setFailed] = useState(false);
  // Sembrar la demo escribe datos del negocio: solo Propietario (dev-tasks/00).
  const owner = isOwner(useViewer());

  async function seed() {
    setSeeding(true);
    const res = await fetch("/api/seed/demo", { method: "POST" }).catch(
      () => null
    );
    setSeeding(false);
    if (res?.ok) onSeeded();
    else setFailed(true);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">Sin conversaciones todavía</p>
      <p className="text-xs text-text-3">
        Cuando alguien escriba a tu número de WhatsApp, su conversación
        aparecerá aquí en tiempo real.
      </p>
      {owner && !failed && (
        <Button
          size="sm"
          variant="outline"
          disabled={seeding}
          onClick={() => void seed()}
        >
          <Sparkles className="h-4 w-4" strokeWidth={1.7} />
          {seeding ? "Cargando demo…" : "Cargar datos de demostración"}
        </Button>
      )}
    </div>
  );
}

/**
 * 06 — Pie de la lista paginada. El botón "Cargar más" es el respaldo
 * accesible del scroll infinito (teclado, lectores de pantalla, navegadores
 * sin IntersectionObserver).
 */
function ListFooter({
  hasMore,
  loadingMore,
  failed,
  empty,
  onLoadMore,
}: {
  hasMore: boolean;
  loadingMore: boolean;
  failed: boolean;
  empty: boolean;
  onLoadMore?: () => void;
}) {
  if (loadingMore) {
    return (
      <p role="status" className="p-4 text-center text-xs text-text-3">
        Cargando…
      </p>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 p-4 text-center">
        <p className="text-xs text-text-3">No se pudieron cargar más conversaciones.</p>
        <Button size="sm" variant="outline" onClick={onLoadMore}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (hasMore) {
    return (
      <div className="flex justify-center p-4">
        <Button size="sm" variant="outline" onClick={onLoadMore}>
          Cargar más
        </Button>
      </div>
    );
  }
  if (empty) return null;
  return (
    <p className="p-4 text-center text-xs text-text-3">No hay más conversaciones</p>
  );
}

/** 020: opción de un grupo excluyente del panel (canal, origen). */
function PanelOption({
  on,
  label,
  count,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[12.5px] font-medium transition-colors",
        on ? "border-brand bg-brand text-brand-fg" : "bg-background text-text-2 hover:bg-accent"
      )}
    >
      {children}
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[11px]",
            on ? "bg-brand-veil" : "bg-secondary text-text-3"
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** 020: un filtro sí/no del panel (Sin asignar, Por cerrar). */
function PanelToggle({
  on,
  label,
  hint,
  count,
  onChange,
}: {
  on: boolean;
  label: string;
  hint: string;
  count: number;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1.5 text-left hover:bg-accent"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">
          {label} <span className="text-[11px] font-normal text-text-3">({count})</span>
        </span>
        <span className="block text-[11px] text-text-3">{hint}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors",
          on ? "bg-brand" : "bg-border-strong"
        )}
      >
        <span
          className={cn(
            "h-4 w-4 rounded-full bg-knob shadow-sm transition-transform",
            on ? "translate-x-4" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}

/** 020: un filtro activo como etiqueta removible (x). */
function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-soft bg-brand-tint py-0.5 pl-2 pr-1 text-[11.5px] text-brand-text">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Quitar filtro: ${label}`}
        className="shrink-0 rounded-full p-0.5 hover:bg-brand-veil"
      >
        <X className="h-3 w-3" strokeWidth={2} />
      </button>
    </span>
  );
}

export function ConversationList({
  conversations: conversationsProp,
  counts,
  filters,
  onFiltersChange,
  channels,
  selectedId,
  onSelect,
  onSeeded,
  teamMode = false,
  hasMore = false,
  loadingMore = false,
  error = null,
  onLoadMore,
  onRetry,
}: {
  /** 06: lo cargado y dentro del filtro activo; null = primera carga. */
  conversations: ConversationDto[] | null;
  /** 06: contadores de `/counts` (o los de respaldo sobre lo cargado). */
  counts: ConversationCounts | null;
  /** 06: filtros activos; viven en `useInboxList` (son del servidor). */
  filters: InboxFilters;
  onFiltersChange: (patch: Partial<InboxFilters>) => void;
  /**
   * 09: ¿se enseña la asignación (pastillas "Mías"/"Sin asignar" y
   * responsable en la fila)? No con el Propietario trabajando solo.
   */
  teamMode?: boolean;
  /** Canales encendidos en esta instancia (ADR-001). */
  channels: readonly Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSeeded: () => void;
  /** 06: ¿hay página siguiente (`nextCursor`)? */
  hasMore?: boolean;
  loadingMore?: boolean;
  error?: InboxListError;
  onLoadMore?: () => void;
  /** 06: reintenta la primera página tras un error. */
  onRetry?: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const viewer = useViewer();
  const viewerOwner = isOwner(viewer);
  // Sin asignación a la vista (Propietario solo), "Mías" y "Sin asignar" no
  // se enseñan ni filtran (lo mismo hace `effectiveFilters` con lo que viaja).
  const filter: InboxView = !teamMode && filters.filter === "mine" ? "all" : filters.filter;
  const unassignedOn = teamMode && filters.unassigned;
  const stage = filters.stageId ?? "all";
  const inbox: Channel | "all" = filters.channel ?? "all";
  // 020: panel "Filtros" (desplegable en escritorio, hoja inferior en móvil).
  const [panelOpen, setPanelOpen] = useState(false);
  const activeCount = panelFilterCount({ ...filters, unassigned: unassignedOn });
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  // La búsqueda la hace el servidor (06): se manda tras una pausa al teclear.
  const onFiltersChangeRef = useRef(onFiltersChange);
  onFiltersChangeRef.current = onFiltersChange;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function pushQuery(value: string, now = false) {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (now) {
      searchTimer.current = null;
      onFiltersChangeRef.current({ q: value });
      return;
    }
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      onFiltersChangeRef.current({ q: value });
    }, SEARCH_DEBOUNCE_MS);
  }
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );

  /**
   * Rescate de lo tecleado ANTES de que hidratara el JS. La caja se pinta en
   * el HTML del servidor, así que se puede escribir en ella mientras carga la
   * página; al montar, React la dejaba vacía y esas pulsaciones se perdían en
   * silencio (el usuario veía la lista entera "sin filtrar"). Por eso el input
   * es NO controlado: el DOM manda y aquí solo adoptamos su valor.
   */
  useEffect(() => {
    const typed = inputRef.current?.value ?? "";
    if (typed) pushQuery(typed, true);
  }, []);

  // 05: reloj de la cuenta regresiva «Cierra en …» (desde `lastInboundAt`,
  // no del `windowRemainingMs` serializado, que envejece).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOSING_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const loading = conversationsProp === null;
  const visible = conversationsProp ?? [];
  // 020 (rediseño 4.4): un renglón de VISTAS excluyentes. Lo demás (canal,
  // etapa, origen, sin asignar, por cerrar) vive en el panel "Filtros".
  const views: { id: InboxView; label: string; count: number }[] = [
    { id: "all", label: "Todas", count: counts?.all ?? 0 },
    { id: "unread", label: "No leídas", count: counts?.unread ?? 0 },
    ...(teamMode ? [{ id: "mine" as const, label: "Mías", count: counts?.mine ?? 0 }] : []),
    { id: "human", label: "Atención humana", count: counts?.human ?? 0 },
  ];
  const ORIGINS: { id: InboxOrigin | null; label: string; count?: number }[] = [
    { id: null, label: "Todos" },
    { id: "ad", label: "De anuncio", count: counts?.origin?.ad ?? 0 },
    { id: "none", label: "Sin anuncio", count: counts?.origin?.none ?? 0 },
  ];
  // Con un solo canal encendido no hay bandejas que distinguir: ni marca en
  // los renglones ni filtro. La pantalla queda exactamente como antes de 014.
  const multiChannel = channels.length > 1;

  // 06: las opciones salen del pipeline completo (el filtro va por id y la
  // página cargada ya no representa a toda la Bandeja). El color del punto
  // sale del tipo y la posición de la etapa (ver lib/stage-colors).
  const { stages: pipelineStages, reload: reloadStages } = useStages();
  // Si aparece un nombre que la lista no conoce (el dueño renombró o creó una
  // etapa con la Bandeja abierta), se pide la lista otra vez — una sola vez
  // por combinación de nombres desconocidos, para no entrar en bucle.
  const unknownStages = [
    ...new Set(
      visible
        .map((c) => c.stageName)
        .filter((n): n is string => !!n && !pipelineStages.some((s) => s.name === n))
    ),
  ].join("|");
  const askedFor = useRef("");
  useEffect(() => {
    if (!unknownStages || pipelineStages.length === 0) return;
    if (askedFor.current === unknownStages) return;
    askedFor.current = unknownStages;
    void reloadStages();
  }, [unknownStages, pipelineStages.length, reloadStages]);

  function selectStage(id: string) {
    if (id === "all") {
      onFiltersChange({ stageId: null, stageName: null });
      return;
    }
    const s = pipelineStages.find((x) => x.id === id);
    onFiltersChange({ stageId: id, stageName: s?.name ?? null });
  }

  function clearQuery() {
    if (inputRef.current) inputRef.current.value = "";
    pushQuery("", true);
    inputRef.current?.focus();
  }

  // Scroll infinito: un centinela al pie pide la página siguiente al
  // acercarse (400px antes). Se vuelve a observar tras cada página para que,
  // si el centinela sigue a la vista, se pida la otra.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const canLoadMore = hasMore && !loadingMore && error !== "more";
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current?.();
      },
      { root: scrollRef.current, rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadMore, visible.length]);

  // La fila activa a la vista (CA-06-05): el enlace `?contact=` puede abrir
  // una conversación antigua que entra por su `sortAt` al fondo de lo
  // cargado. Depende solo de QUÉ fila y de SI ya está pintada — no de la
  // lista entera — para no mover el scroll en cada upsert por SSE; con
  // `nearest`, al hacer clic en una fila ya visible no pasa nada.
  const activeRendered = selectedId != null && visible.some((c) => c.id === selectedId);
  useEffect(() => {
    if (!activeRendered || !selectedId) return;
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>("[data-conversation-id]");
    const row = Array.from(rows ?? []).find(
      (el) => el.dataset.conversationId === selectedId
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId, activeRendered]);

  const noFilters = !hasActiveFilters({ ...filters, filter, unassigned: unassignedOn, q: query });
  const stageLabel =
    filters.stageName ?? pipelineStages.find((s) => s.id === filters.stageId)?.name ?? "Etapa";
  // Filtros activos como etiquetas removibles (x).
  const chips: { key: string; label: string; remove: () => void }[] = [
    ...(filters.channel
      ? [
          {
            key: "channel",
            label: CHANNEL_LABEL[filters.channel],
            remove: () => onFiltersChange({ channel: null }),
          },
        ]
      : []),
    ...(filters.stageId
      ? [
          {
            key: "stage",
            label: `Etapa: ${stageLabel}`,
            remove: () => onFiltersChange({ stageId: null, stageName: null }),
          },
        ]
      : []),
    ...(filters.origin
      ? [
          {
            key: "origin",
            label: filters.origin === "ad" ? "De anuncio" : "Sin anuncio",
            remove: () => onFiltersChange({ origin: null }),
          },
        ]
      : []),
    ...(unassignedOn
      ? [{ key: "unassigned", label: "Sin asignar", remove: () => onFiltersChange({ unassigned: false }) }]
      : []),
    ...(filters.closing
      ? [{ key: "closing", label: "Por cerrar", remove: () => onFiltersChange({ closing: false }) }]
      : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[17px] font-[650] tracking-tight">Bandeja</h2>
          <span className="text-sm text-text-3">{counts?.all ?? visible.length}</span>
          {multiChannel && (
            <div className="ml-auto flex items-center gap-1">
              {channels.map((ch) => {
                const on = inbox === ch;
                return (
                  <button
                    key={ch}
                    onClick={() => onFiltersChange({ channel: on ? null : ch })}
                    aria-pressed={on}
                    title={
                      on
                        ? "Ver todas las bandejas"
                        : `Ver solo ${CHANNEL_LABEL[ch]}`
                    }
                    className={cn(
                      "flex items-center gap-1 rounded-full border py-[3px] pl-[5px] pr-2 text-[11.5px] font-medium transition-colors",
                      on
                        ? "border-brand bg-brand-veil text-foreground"
                        : "text-text-3 hover:bg-accent",
                      inbox !== "all" && !on && "opacity-45"
                    )}
                  >
                    <ChannelBadge
                      channel={ch}
                      className="h-[13px] w-[13px] rounded-[4px]"
                    />
                    {counts?.byChannel[ch] ?? 0}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-secondary px-3 py-[7px] transition-colors focus-within:border-brand focus-within:bg-background focus-within:ring-[3px] focus-within:ring-brand-soft">
          <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
          <input
            ref={inputRef}
            placeholder="Buscar por nombre o teléfono…"
            aria-label="Buscar conversación"
            defaultValue=""
            onChange={(e) => pushQuery(e.target.value)}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-3"
          />
          {query && (
            <button
              onClick={clearQuery}
              aria-label="Limpiar búsqueda"
              className="shrink-0 rounded-full p-0.5 text-text-3 hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
      </header>

      <AlertsBanner />

      {/* 020 (rediseño 4.4): renglón de vistas excluyentes + botón "Filtros".
          Si no cabe en la columna, el botón baja de línea (flex-wrap) en vez
          de salirse por la derecha. */}
      <div className="relative border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => onFiltersChange({ filter: v.id })}
              aria-pressed={filter === v.id}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[12.5px] font-medium transition-colors",
                filter === v.id
                  ? "border-brand bg-brand text-brand-fg"
                  : "bg-background text-text-2 hover:bg-accent"
              )}
            >
              {v.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px]",
                  filter === v.id ? "bg-brand-veil" : "bg-secondary text-text-3"
                )}
              >
                {v.count}
              </span>
            </button>
          ))}

          <button
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            aria-label={activeCount > 0 ? `Filtros (${activeCount} activos)` : "Filtros"}
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[5px] text-[12.5px] font-medium transition-colors",
              activeCount > 0 || panelOpen
                ? "border-brand bg-brand-veil text-foreground"
                : "bg-background text-text-2 hover:bg-accent"
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.8} />
            Filtros
            {activeCount > 0 && (
              <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-brand px-1 text-[10.5px] font-semibold text-brand-fg">
                {activeCount}
              </span>
            )}
          </button>
        </div>

        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Filtros activos">
            {chips.map((c) => (
              <ActiveChip key={c.key} label={c.label} onRemove={c.remove} />
            ))}
            <button
              onClick={() => onFiltersChange(clearPanelFilters())}
              className="text-[11.5px] font-medium text-text-3 underline underline-offset-2 hover:text-foreground"
            >
              Limpiar
            </button>
          </div>
        )}

        {panelOpen && (
          <>
            {/* Velo: tocar fuera cierra. En escritorio es transparente. */}
            <button
              aria-label="Cerrar filtros"
              tabIndex={-1}
              onClick={() => setPanelOpen(false)}
              className="fixed inset-0 z-40 bg-overlay md:bg-transparent"
            />
            <div
              role="dialog"
              aria-label="Filtros de la Bandeja"
              className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-xl border-t bg-background p-4 shadow-pop md:absolute md:inset-x-4 md:bottom-auto md:top-full md:mt-1 md:max-h-[70vh] md:rounded-md md:border"
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[13px] font-[650]">Filtros</p>
                <button
                  onClick={() => setPanelOpen(false)}
                  aria-label="Cerrar el panel de filtros"
                  className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" strokeWidth={1.7} />
                </button>
              </div>

              {multiChannel && (
                <section className="mb-3">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                    Canal
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <PanelOption
                      on={inbox === "all"}
                      label="Todos"
                      onClick={() => onFiltersChange({ channel: null })}
                    />
                    {channels.map((ch) => (
                      <PanelOption
                        key={ch}
                        on={inbox === ch}
                        label={CHANNEL_LABEL[ch]}
                        count={counts?.byChannel[ch] ?? 0}
                        onClick={() => onFiltersChange({ channel: ch })}
                      >
                        <ChannelBadge channel={ch} className="h-[13px] w-[13px] rounded-[4px]" />
                      </PanelOption>
                    ))}
                  </div>
                </section>
              )}

              {pipelineStages.length > 0 && (
                <section className="mb-3">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                    Etapa
                  </p>
                  <select
                    value={stage}
                    onChange={(e) => selectStage(e.target.value)}
                    aria-label="Filtrar por etapa del embudo"
                    className={cn(
                      "w-full truncate rounded-md border px-2 py-[6px] text-[13px] transition-colors",
                      stage === "all"
                        ? "bg-background text-text-2"
                        : "border-brand bg-brand-veil text-foreground"
                    )}
                  >
                    <option value="all">Toda etapa</option>
                    {pipelineStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </section>
              )}

              <section className="mb-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                  Origen
                </p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Origen">
                  {ORIGINS.map((o) => (
                    <PanelOption
                      key={o.id ?? "all"}
                      on={filters.origin === o.id}
                      label={o.label}
                      count={o.count}
                      onClick={() => onFiltersChange({ origin: o.id })}
                    />
                  ))}
                </div>
              </section>

              <section className="mb-3 space-y-0.5">
                {teamMode && (
                  <PanelToggle
                    on={unassignedOn}
                    label="Sin asignar"
                    hint="Solo las que nadie ha tomado"
                    count={counts?.unassigned ?? 0}
                    onChange={(on) => onFiltersChange({ unassigned: on })}
                  />
                )}
                <PanelToggle
                  on={filters.closing}
                  label="Por cerrar"
                  hint="La ventana para responder sin plantilla cierra en menos de 2 h"
                  count={counts?.closing ?? 0}
                  onChange={(on) => onFiltersChange({ closing: on })}
                />
              </section>

              <div className="flex items-center justify-between gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={activeCount === 0}
                  onClick={() => onFiltersChange(clearPanelFilters())}
                >
                  Limpiar
                </Button>
                <Button size="sm" onClick={() => setPanelOpen(false)}>
                  Listo
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {loading ? (
          error === "first" ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <p className="text-xs text-text-3">No se pudo cargar la Bandeja.</p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                Reintentar
              </Button>
            </div>
          ) : (
            <p className="p-6 text-center text-xs text-text-3">Cargando…</p>
          )
        ) : visible.length === 0 && noFilters && !hasMore ? (
          <EmptyState onSeeded={onSeeded} />
        ) : visible.length === 0 && !hasMore ? (
          <p className="p-6 text-center text-xs text-text-3">
            {activeCount > 0
              ? "Sin resultados para estos filtros."
              : filter === "human"
                ? "Ninguna conversación requiere atención humana."
                : filter === "mine"
                  ? "No tienes conversaciones a tu nombre."
                  : "Sin resultados para este filtro."}
          </p>
        ) : (
          <ul>
            {visible.map((c) => {
              const unread = c.unreadCount > 0;
              const closesIn = closingRemainingMs(c.channel, c.lastInboundAt, now);
              const active = selectedId === c.id;
              return (
                <li
                  key={c.id}
                  data-conversation-id={c.id}
                  className="relative border-b border-border/70"
                >
                  {active && (
                    <span className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
                  )}
                  <button
                    onClick={() => onSelect(c.id)}
                    className={cn(
                      "flex w-full items-start gap-[11px] px-4 py-[var(--row-py)] text-left transition-colors",
                      active ? "bg-[var(--bg-active)]" : "hover:bg-subtle"
                    )}
                  >
                    <span className="relative shrink-0">
                      <ContactAvatar name={c.contact.name} seed={c.contact.id} size="lg" />
                      {c.windowOpen && (
                        <span className="absolute bottom-0 right-0 h-[11px] w-[11px] rounded-full border-[2.5px] border-background bg-success" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {multiChannel && <ChannelBadge channel={c.channel} />}
                          <span
                            className={cn(
                              "truncate text-sm",
                              unread ? "font-[680]" : "font-semibold"
                            )}
                          >
                            {c.contact.name}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-[11.5px]",
                            unread ? "font-semibold text-brand" : "text-text-3"
                          )}
                        >
                          {formatTime(c.lastMessageAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-[13px]",
                            unread ? "font-medium text-text-2" : "text-text-3"
                          )}
                        >
                          {previewText(c.preview)}
                        </span>
                        {unread && (
                          <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10.5px] font-semibold text-brand-fg">
                            {c.unreadCount}
                          </span>
                        )}
                      </span>
                      <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
                        {c.anuncio && <EtiquetaDeOrigen anuncio={c.anuncio} />}
                        {c.stageName && (
                          <span className="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-2 py-0.5 text-[11px] text-text-2">
                            <span
                              className="h-[7px] w-[7px] rounded-full"
                              style={{
                                background: stageColorByName(
                                  c.stageName,
                                  pipelineStages
                                ),
                              }}
                            />
                            {c.stageName}
                          </span>
                        )}
                        {/* Uno u otro, nunca ambos: el handoff manda sobre la
                            IA apagada a mano (ver needsHuman). */}
                        {c.handoffAt ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-warning-soft bg-warning-tint px-2 py-0.5 text-[11px] text-warning-text">
                            <UserRound className="h-3 w-3" strokeWidth={1.7} />
                            Atención humana
                          </span>
                        ) : c.aiEnabled === false ? (
                          <span className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-[11px] text-text-3">
                            <PauseCircle className="h-3 w-3" strokeWidth={1.7} />
                            IA pausada
                          </span>
                        ) : null}
                        {closesIn !== null && (
                          <span
                            data-testid="closing-chip"
                            title="La ventana de 24 h para responder sin plantilla está por cerrar"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning-soft bg-warning-tint px-2 py-0.5 text-[11px] text-warning-text"
                          >
                            <Hourglass className="h-3 w-3" strokeWidth={1.7} />
                            Cierra en {formatRemaining(closesIn)}
                          </span>
                        )}
                        {teamMode && <AssigneeTag c={c} viewerId={viewer.userId} owner={viewerOwner} />}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && (
          <ListFooter
            hasMore={hasMore}
            loadingMore={loadingMore}
            failed={error === "more"}
            empty={visible.length === 0}
            onLoadMore={onLoadMore}
          />
        )}
        <div ref={sentinelRef} aria-hidden className="h-px" />
      </div>
    </div>
  );
}
