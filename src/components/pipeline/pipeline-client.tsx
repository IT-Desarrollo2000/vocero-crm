"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ArrowRight, Settings2, Trophy, X, XCircle } from "lucide-react";
import type { LossReason, PriorityValue, StageDto } from "@/lib/types";
import type { Channel, ReplyMode } from "@/lib/channels";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useViewer } from "@/components/viewer-context";
import { useEvents } from "@/components/use-events";
import { isOwner } from "@/lib/roles";
import { coalesce } from "@/lib/time/calendar";
import {
  FILTER_LABEL,
  cardView,
  defaultFilter,
  emptyColumnText,
  filterCounts,
  matchesFilter,
  parseFilter,
  pipelineTodo,
  stageFooterText,
  stageSubtitle,
  type CardAction,
  type CardChip,
  type CardView,
  type CardViewer,
  type PipelineFilter,
  type TodoItem,
} from "@/lib/pipeline-card";
import { StageManager } from "./stage-manager";
import { LossReasonDialog } from "./loss-reason-dialog";
import { AmountDialog } from "./amount-dialog";
import { PriorityBadge } from "./priority-picker";
import { LeadDrawer } from "./lead-drawer";

export type BoardLead = {
  id: string;
  stageId: string;
  position: number;
  lastActivityAt: string | null;
  contact: { id: string; name: string; phone: string | null };
  conversationId: string | null;
  amountCents: number | null;
  currency: string | null;
  priority: PriorityValue | null;
  /* 032 (aditivo) */
  channel: Channel | null;
  assignedTo: { id: string; name: string } | null;
  awaitingSince: string | null;
  lastInboundAt: string | null;
  window: { open: boolean; remainingMs: number; replyMode: ReplyMode } | null;
  nextBooking: { id: string; scheduledAtUtc: string } | null;
};

type BoardResponse = {
  stages: StageDto[];
  leads: BoardLead[];
  currency?: string;
  businessTimezone?: string;
  teamMode?: boolean;
  agenda?: boolean;
};

const FILTERS: PipelineFilter[] = ["mine", "unassigned", "all"];
/** Rebote de la recarga en vivo: una ráfaga de eventos = un solo pedido. */
const LIVE_DEBOUNCE_MS = 800;

export function PipelineClient() {
  // Las etapas son del Propietario (dev-tasks/00, RF-00-07); mover tarjetas,
  // monto, prioridad y motivo de pérdida sí son de todos.
  const me = useViewer();
  const owner = isOwner(me);
  const router = useRouter();
  const [stages, setStages] = useState<StageDto[]>([]);
  const [currency, setCurrency] = useState("MXN");
  const [tz, setTz] = useState("America/Mexico_City");
  const [teamMode, setTeamMode] = useState(true);
  const [agenda, setAgenda] = useState(false);
  const [leads, setLeads] = useState<BoardLead[]>([]);
  /** `loading` hasta la primera respuesta; `error` si la primera falló. */
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  /** Una recarga posterior falló: el tablero sigue, pero se avisa. */
  const [staleBoard, setStaleBoard] = useState(false);
  /** Aviso de una acción que no salió (mover, monto, prioridad, tomar). */
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activeLead, setActiveLead] = useState<BoardLead | null>(null);
  const [managing, setManaging] = useState(false);
  /** Arrastre hacia una etapa perdida, esperando el motivo. */
  const [pendingLoss, setPendingLoss] = useState<{
    leadId: string;
    stageId: string;
    name: string;
  } | null>(null);
  /** Tarjeta cuyo monto se está capturando. */
  const [editandoMonto, setEditandoMonto] = useState<BoardLead | null>(null);
  /**
   * Trato abierto en el cajón. Se guarda el ID y no el objeto: así el cajón
   * lee siempre del tablero y refleja al instante lo que se cambie desde
   * dentro, en vez de enseñar una copia que envejece.
   */
  const [abiertoId, setAbiertoId] = useState<string | null>(null);
  const abierto = leads.find((l) => l.id === abiertoId) ?? null;
  const [taking, setTaking] = useState<string | null>(null);

  /* 032 — filtro recordado por usuario; por defecto según el rol. */
  const filterKey = `vocero.pipelineFilter.${me.userId}`;
  const [filter, setFilterState] = useState<PipelineFilter>(() => defaultFilter(me.role));
  useEffect(() => {
    // En efecto (no en el estado inicial): el servidor no tiene localStorage
    // y la hidratación debe pintar lo mismo que él.
    const saved = parseFilter(localStorage.getItem(filterKey));
    if (saved) setFilterState(saved);
  }, [filterKey]);
  const setFilter = useCallback(
    (f: PipelineFilter) => {
      setFilterState(f);
      try {
        localStorage.setItem(filterKey, f);
      } catch {
        /* modo privado: se usa sin recordar */
      }
    },
    [filterKey]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const refetch = useCallback(async () => {
    const res = await fetch("/api/pipeline/board").catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as BoardResponse | null) : null;
    if (!data) {
      setStatus((s) => (s === "ready" ? s : "error"));
      setStaleBoard(true);
      return;
    }
    if (data.currency) setCurrency(data.currency);
    if (data.businessTimezone) setTz(data.businessTimezone);
    if (typeof data.teamMode === "boolean") setTeamMode(data.teamMode);
    setAgenda(data.agenda === true);
    setStages(data.stages);
    setLeads(data.leads);
    setNow(Date.now());
    setStaleBoard(false);
    setStatus("ready");
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Tiempo real: un mensaje nuevo o un chat que cambia de manos se refleja
  // sin recargar la página. Se rebota para no pedir el tablero por evento.
  const live = useRef<ReturnType<typeof coalesce> | null>(null);
  useEffect(() => {
    const c = coalesce(() => void refetch(), LIVE_DEBOUNCE_MS);
    live.current = c;
    return () => c.cancel();
  }, [refetch]);
  const onLive = useCallback(() => live.current?.trigger(), []);
  useEvents({
    onConversationUpdated: onLive,
    onMessageNew: onLive,
    onBookingUpdated: onLive,
    onReconnect: onLive,
  });

  // «Espera respuesta · 12 min» avanza con el reloj, sin volver a pedir nada.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const cardViewer: CardViewer = useMemo(
    () => ({ userId: me.userId, role: me.role, teamMode }),
    [me.userId, me.role, teamMode]
  );
  const stageKind = useMemo(() => {
    const m = new Map(stages.map((s) => [s.id, s.kind]));
    return (stageId: string) => m.get(stageId) ?? "open";
  }, [stages]);

  const counts = useMemo(() => filterCounts(leads, cardViewer), [leads, cardViewer]);
  // Sin equipo, «Mis clientes» = todo lo que tiene chat (`ownershipOf`).
  const activeFilter: PipelineFilter = filter;
  const todo = useMemo(
    () =>
      pipelineTodo(
        leads.map((l) => ({ ...l, stageKind: stageKind(l.stageId) })),
        { viewer: cardViewer, now, tz, agenda }
      ),
    [leads, stageKind, cardViewer, now, tz, agenda]
  );

  function onDragStart(event: DragStartEvent) {
    const lead = leads.find((l) => l.id === event.active.id);
    setActiveLead(lead ?? null);
  }

  async function patchLead(leadId: string, body: object, failMsg: string) {
    const res = await fetch(`/api/pipeline/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      const data = res
        ? ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)
        : null;
      setNotice(
        res ? `${failMsg}${data?.error?.message ? `: ${data.error.message}` : "."}` : `${failMsg}: sin conexión con el servidor.`
      );
    }
    // Con éxito o sin él, el tablero vuelve a la verdad del servidor (y el
    // optimista que falló regresa a su lugar).
    void refetch();
  }

  async function moverLead(
    leadId: string,
    overStage: string,
    loss?: { reason: LossReason; note: string }
  ) {
    // La posición se calcula sobre el tablero COMPLETO, no sobre lo que el
    // filtro deja ver: la tarjeta va al final de la etapa real.
    const position = leads.filter((l) => l.stageId === overStage).length;
    const lead = leads.find((l) => l.id === leadId);
    const destino = stages.find((s) => s.id === overStage);
    // Optimista + persistencia
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, stageId: overStage, position } : l))
    );
    await patchLead(
      leadId,
      {
        stageId: overStage,
        position,
        ...(loss
          ? { lossReason: loss.reason, ...(loss.note ? { lossNote: loss.note } : {}) }
          : {}),
      },
      `No se pudo mover a ${lead?.contact.name ?? "este cliente"} a ${destino?.name ?? "esa etapa"}; volvió a su lugar`
    );
  }

  async function guardarMonto(leadId: string, cents: number | null) {
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, amountCents: cents } : l))
    );
    // Sin `stageId`: esto NO mueve la tarjeta, solo escribe el importe.
    await patchLead(leadId, { amountCents: cents }, "No se pudo guardar el monto");
  }

  async function guardarPrioridad(leadId: string, priority: PriorityValue | null) {
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, priority } : l))
    );
    await patchLead(leadId, { priority }, "No se pudo guardar la prioridad");
  }

  /**
   * «Tomar y responder»: la misma toma atómica que el Buzón
   * (`expect: "unassigned"`); si alguien se adelantó, se dice quién.
   */
  async function tomar(lead: BoardLead, conversationId: string) {
    setTaking(lead.id);
    const res = await fetch(`/api/conversations/${conversationId}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: me.userId, expect: "unassigned" }),
    }).catch(() => null);
    setTaking(null);
    if (res?.ok) {
      router.push(`/inbox?contact=${lead.contact.id}`);
      return;
    }
    const data = res
      ? ((await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string; assignedTo?: { name?: string } };
        } | null)
      : null;
    if (!res) setNotice("No se pudo tomar el chat: sin conexión con el servidor.");
    else if (data?.error?.code === "already_assigned") {
      const who = data.error.assignedTo?.name;
      setNotice(
        who
          ? `${who} ya tomó el chat de ${lead.contact.name}.`
          : `Otro vendedor ya tomó el chat de ${lead.contact.name}.`
      );
    } else setNotice(data?.error?.message ?? "No se pudo tomar el chat.");
    void refetch();
  }

  async function onDragEnd(event: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(event.active.id);
    const overStage = event.over ? String(event.over.id) : null;
    if (!overStage) return;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stageId === overStage) return;

    // Perder un trato exige motivo. Se pregunta ANTES de mover: si el dueño
    // cancela, la tarjeta ni siquiera parpadea fuera de su columna.
    const destino = stages.find((s) => s.id === overStage);
    if (destino?.kind === "lost") {
      setPendingLoss({ leadId, stageId: overStage, name: lead.contact.name });
      return;
    }

    await moverLead(leadId, overStage);
  }

  /**
   * Cambiar de etapa desde el cajón. Entra por la MISMA puerta que el
   * arrastre: perder un trato exige motivo venga de donde venga, y duplicar
   * esa regla aquí sería tener dos sitios donde olvidarla.
   */
  function moverDesdeCajon(leadId: string, stageId: string) {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stageId === stageId) return;
    const destino = stages.find((s) => s.id === stageId);
    if (destino?.kind === "lost") {
      setPendingLoss({ leadId, stageId, name: lead.contact.name });
      return;
    }
    void moverLead(leadId, stageId);
  }

  function onTodo(item: TodoItem) {
    const lead = leads.find((l) => l.id === item.leadId);
    if (item.id === "noAmount" && lead) setEditandoMonto(lead);
    else if (item.id === "stale" && lead) setAbiertoId(lead.id);
  }

  const viewOf = (lead: BoardLead): CardView =>
    cardView(lead, {
      viewer: cardViewer,
      now,
      tz,
      currency,
      stageKind: stageKind(lead.stageId),
    });

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="min-w-0 flex-[1_1_280px] space-y-0.5">
          <h2 className="font-semibold">Seguimiento</h2>
          <p className="text-[13px] text-text-2">
            En qué va cada cliente. Arrastra la tarjeta a su nueva etapa, o ábrela y elige la etapa ahí.
          </p>
        </div>
        {status === "ready" && (
          <div
            role="group"
            aria-label="Qué clientes ver"
            className="inline-flex flex-wrap gap-1 rounded-lg bg-secondary p-[3px]"
          >
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={activeFilter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeFilter === f
                    ? "bg-background font-semibold text-foreground shadow-sm"
                    : "text-text-2 hover:text-foreground"
                )}
              >
                {FILTER_LABEL[f]} · {counts[f]}
              </button>
            ))}
          </div>
        )}
        {owner && (
          <Button variant="outline" size="sm" onClick={() => setManaging(true)}>
            <Settings2 className="h-4 w-4" /> Gestionar etapas
          </Button>
        )}
      </header>

      {/* El tablero se arrastra en horizontal; en el teléfono cada columna
          se detiene en su sitio (snap) para no quedar a medio camino. Todo lo
          nuevo (franja, avisos) va DENTRO de este contenedor: `main` nunca
          desborda a 390 px. */}
      <div className="flex flex-1 snap-x snap-mandatory flex-col gap-3 overflow-x-auto p-3 sm:snap-none sm:p-4">
        {notice && (
          <div
            role="alert"
            className="sticky left-0 flex items-start gap-2 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
          >
            <p className="flex-1">{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Cerrar el aviso"
              className="rounded p-0.5 hover:bg-background/60"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {status === "ready" && staleBoard && (
          <div
            role="status"
            className="sticky left-0 flex flex-wrap items-center gap-2 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text"
          >
            <p className="flex-1">No se pudo actualizar el tablero; lo que ves puede estar atrasado.</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Reintentar
            </Button>
          </div>
        )}

        {status === "loading" && <BoardSkeleton />}

        {status === "error" && (
          <div
            role="alert"
            className="sticky left-0 mx-auto mt-8 w-full max-w-md space-y-3 rounded-lg border bg-card p-5 text-center"
          >
            <p className="font-semibold">No se pudo cargar el tablero.</p>
            <p className="text-sm text-text-2">Revisa tu conexión y vuelve a intentarlo.</p>
            <Button
              onClick={() => {
                setStatus("loading");
                void refetch();
              }}
            >
              Reintentar
            </Button>
          </div>
        )}

        {status === "ready" && todo.length > 0 && (
          <TodoStrip items={todo} onGo={onTodo} />
        )}

        {status === "ready" && (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={(e) => void onDragEnd(e)}
          >
            <div className="flex min-h-0 flex-1 gap-3">
              {stages.map((stage) => {
                const all = leads.filter((l) => l.stageId === stage.id);
                // Filtrar NO reordena: el orden es el del arrastre.
                const visible = all
                  .filter((l) => matchesFilter(l, activeFilter, cardViewer))
                  .sort((a, b) => a.position - b.position);
                return (
                  <StageColumn
                    key={stage.id}
                    stage={stage}
                    currency={currency}
                    leads={visible}
                    hiddenByFilter={all.length > 0 && visible.length === 0 ? activeFilter : null}
                    viewOf={viewOf}
                    takingId={taking}
                    onEditAmount={setEditandoMonto}
                    onOpen={(l) => setAbiertoId(l.id)}
                    onTake={(l, cid) => void tomar(l, cid)}
                  />
                );
              })}
            </div>
            <DragOverlay>
              {activeLead ? (
                <LeadCard lead={activeLead} view={viewOf(activeLead)} overlay />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {owner && managing && (
        <StageManager
          stages={stages}
          onClose={() => setManaging(false)}
          onChanged={() => void refetch()}
        />
      )}

      {/* Va ANTES que los diálogos: con el mismo z-index, el que se pinta
          después queda encima, y el motivo de pérdida debe tapar al cajón. */}
      {abierto && (
        <LeadDrawer
          lead={abierto}
          stages={stages}
          currency={currency}
          canOpenChat={viewOf(abierto).canOpenChat}
          onClose={() => setAbiertoId(null)}
          onMoveStage={(stageId) => moverDesdeCajon(abierto.id, stageId)}
          onAmount={(cents) => void guardarMonto(abierto.id, cents)}
          onPriority={(p) => void guardarPrioridad(abierto.id, p)}
        />
      )}

      {editandoMonto && (
        <AmountDialog
          leadName={editandoMonto.contact.name}
          currency={editandoMonto.currency ?? currency}
          amountCents={editandoMonto.amountCents}
          priority={editandoMonto.priority}
          onPriorityChange={(p) => {
            setEditandoMonto({ ...editandoMonto, priority: p });
            void guardarPrioridad(editandoMonto.id, p);
          }}
          onCancel={() => setEditandoMonto(null)}
          onSave={(cents) => {
            const leadId = editandoMonto.id;
            setEditandoMonto(null);
            void guardarMonto(leadId, cents);
          }}
        />
      )}

      {pendingLoss && (
        <LossReasonDialog
          leadName={pendingLoss.name}
          onCancel={() => setPendingLoss(null)}
          onConfirm={(reason, note) => {
            const { leadId, stageId } = pendingLoss;
            setPendingLoss(null);
            void moverLead(leadId, stageId, { reason, note });
          }}
        />
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div aria-busy="true" className="flex gap-3">
      <span className="sr-only">Cargando el tablero…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="w-64 shrink-0 space-y-2 rounded-lg border bg-card/50 p-2">
          <div className="h-5 w-24 animate-pulse rounded bg-secondary" />
          <div className="h-20 animate-pulse rounded-md bg-secondary" />
          <div className="h-20 animate-pulse rounded-md bg-secondary" />
        </div>
      ))}
    </div>
  );
}

const TODO_TONE: Record<TodoItem["tone"], { box: string; text: string }> = {
  danger: { box: "border-danger-soft bg-danger-tint hover:border-danger", text: "text-danger-text" },
  warning: { box: "border-warning-soft bg-warning-tint hover:border-warning", text: "text-warning-text" },
  info: { box: "border-info-soft bg-info-tint hover:border-info", text: "text-info-text" },
};

/** «Lo que te toca»: mismo patrón que el resumen de la Bandeja (031). */
function TodoStrip({ items, onGo }: { items: TodoItem[]; onGo: (it: TodoItem) => void }) {
  return (
    <section aria-label="Lo que te toca" className="sticky left-0 flex flex-wrap gap-2.5">
      {items.map((it) => {
        const tone = TODO_TONE[it.tone];
        const body = (
          <>
            <span
              aria-hidden
              className={cn(
                "flex h-7 min-w-[28px] shrink-0 items-center justify-center rounded-full bg-background px-1.5 text-sm font-bold tabular-nums",
                tone.text
              )}
            >
              {it.count}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="text-sm font-semibold text-foreground">{it.title}</strong>
              <span className="text-[12.5px] text-text-2">{it.hint}</span>
            </span>
            <ArrowRight aria-hidden className={cn("h-4 w-4 shrink-0", tone.text)} strokeWidth={1.8} />
          </>
        );
        const cls = cn(
          "flex min-w-0 flex-[1_1_240px] items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          tone.box
        );
        return it.href ? (
          <Link key={it.id} href={it.href} className={cls} data-testid={`pipeline-todo-${it.id}`}>
            {body}
          </Link>
        ) : (
          <button
            key={it.id}
            type="button"
            onClick={() => onGo(it)}
            className={cls}
            data-testid={`pipeline-todo-${it.id}`}
          >
            {body}
          </button>
        );
      })}
    </section>
  );
}

function StageColumn({
  stage,
  leads,
  hiddenByFilter,
  currency,
  viewOf,
  takingId,
  onEditAmount,
  onOpen,
  onTake,
}: {
  stage: StageDto;
  leads: BoardLead[];
  /** La etapa tiene tratos, pero el filtro no deja ver ninguno. */
  hiddenByFilter: PipelineFilter | null;
  currency: string;
  viewOf: (lead: BoardLead) => CardView;
  takingId: string | null;
  onEditAmount: (lead: BoardLead) => void;
  onOpen: (lead: BoardLead) => void;
  onTake: (lead: BoardLead, conversationId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const subtitle = stageSubtitle(stage.kind);
  const footer = stageFooterText(leads, currency);
  return (
    <section
      ref={setNodeRef}
      aria-label={`Etapa ${stage.name}`}
      className={cn(
        "flex h-full w-64 shrink-0 snap-start flex-col rounded-lg border bg-card/50",
        isOver && "ring-2 ring-primary/60"
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {stage.kind === "won" && <Trophy className="h-3.5 w-3.5 shrink-0 text-primary" />}
          {stage.kind === "lost" && (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">
            {stage.name}
            {subtitle && <span className="font-normal text-text-2"> · {subtitle}</span>}
          </span>
        </h3>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {leads.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2 pt-0">
        {leads.length === 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-dashed border-border px-3 py-3.5 text-[12.5px] text-text-2">
            {emptyColumnText(stage.kind, hiddenByFilter).map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        )}
        {leads.map((lead) => (
          <DraggableLead
            key={lead.id}
            lead={lead}
            view={viewOf(lead)}
            taking={takingId === lead.id}
            onEditAmount={onEditAmount}
            onOpen={onOpen}
            onTake={onTake}
          />
        ))}
      </div>
      {footer && (
        <div className="border-t px-3 py-2 text-xs text-text-2">
          <p>{footer.main}</p>
          {footer.otherCurrency && (
            // Descartarlos en silencio haría que la suma mintiera sin que
            // nadie pudiera notarlo.
            <p className="mt-0.5 text-warning-text">{footer.otherCurrency}</p>
          )}
        </div>
      )}
    </section>
  );
}

function DraggableLead({
  lead,
  view,
  taking,
  onEditAmount,
  onOpen,
  onTake,
}: {
  lead: BoardLead;
  view: CardView;
  taking: boolean;
  onEditAmount: (lead: BoardLead) => void;
  onOpen: (lead: BoardLead) => void;
  onTake: (lead: BoardLead, conversationId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      // Abrir y arrastrar conviven porque el sensor solo activa el arrastre a
      // los 6 px de movimiento: un clic quieto nunca llega a ser un arrastre.
      // Los controles de dentro de la tarjeta cortan la propagación, para que
      // tocar "Poner monto" no abra además el cajón.
      onClick={() => onOpen(lead)}
      // dnd-kit ya deja el nodo con `role="button"` y `tabIndex`, pero un div
      // no dispara `click` con el teclado: sin esto, el cajón sería alcanzable
      // solo con el ratón.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(lead);
        }
      }}
      aria-label={`Abrir el trato de ${lead.contact.name}`}
      className={cn(isDragging && "opacity-40")}
    >
      <LeadCard
        lead={lead}
        view={view}
        taking={taking}
        onEditAmount={onEditAmount}
        onTake={onTake}
      />
    </div>
  );
}

const CHIP_TONE: Record<CardChip["tone"], string> = {
  neutral: "border-border bg-secondary text-text-2",
  info: "border-info-soft bg-info-tint text-info-text",
  warning: "border-warning-soft bg-warning-tint font-semibold text-warning-text",
  danger: "border-danger-soft bg-danger-tint font-semibold text-danger-text",
  success: "border-success-soft bg-success-tint text-success-text",
};

/**
 * Los controles de la tarjeta cortan `pointerdown` (si no, tocarlos empieza
 * un arrastre) y `click` (si no, abren además el cajón).
 */
const stop = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

const PRIMARY_CLS =
  "inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const OUTLINE_CLS =
  "inline-flex h-8 items-center rounded-md border px-2.5 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const DASHED_CLS =
  "inline-flex h-8 items-center rounded-md border border-dashed px-2.5 text-[13px] text-text-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function LeadCard({
  lead,
  view,
  overlay = false,
  taking = false,
  onEditAmount,
  onTake,
}: {
  lead: BoardLead;
  view: CardView;
  overlay?: boolean;
  taking?: boolean;
  onEditAmount?: (lead: BoardLead) => void;
  onTake?: (lead: BoardLead, conversationId: string) => void;
}) {
  const interactive = !overlay;

  function renderAction(a: CardAction, primary: boolean) {
    const cls = primary ? PRIMARY_CLS : a.kind === "amount" ? DASHED_CLS : OUTLINE_CLS;
    if (a.kind === "amount") {
      return (
        <button
          key={a.kind}
          type="button"
          {...stop}
          onClick={(e) => {
            e.stopPropagation();
            onEditAmount?.(lead);
          }}
          className={cls}
        >
          {a.label}
        </button>
      );
    }
    if (a.kind === "take") {
      return (
        <button
          key={a.kind}
          type="button"
          {...stop}
          disabled={taking}
          onClick={(e) => {
            e.stopPropagation();
            onTake?.(lead, a.conversationId);
          }}
          className={cls}
        >
          {taking ? "Tomando…" : a.label}
        </button>
      );
    }
    return (
      <Link
        key={a.kind}
        href={a.href}
        {...stop}
        onClick={(e) => e.stopPropagation()}
        className={cls}
      >
        {a.label}
      </Link>
    );
  }

  return (
    <article
      className={cn(
        "flex cursor-grab flex-col gap-1.5 rounded-md border bg-card p-2.5 shadow-sm",
        view.primary?.kind === "amount" && "border-warning-soft",
        overlay && "rotate-2 shadow-xl"
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <p className="truncate text-sm font-semibold">{lead.contact.name}</p>
        {lead.priority && <PriorityBadge value={lead.priority} />}
      </div>
      {view.amount &&
        (interactive && onEditAmount ? (
          <button
            type="button"
            {...stop}
            onClick={(e) => {
              e.stopPropagation();
              onEditAmount(lead);
            }}
            aria-label={`Cambiar el monto: ${view.amount}`}
            className="self-start rounded px-1 text-sm font-semibold tabular-nums hover:bg-accent"
          >
            {view.amount}
          </button>
        ) : (
          <p className="text-sm font-semibold tabular-nums">{view.amount}</p>
        ))}
      {view.chips.map((c) => (
        <span
          key={c.id}
          className={cn(
            "self-start rounded-full border px-2 py-px text-[11.5px] font-medium",
            CHIP_TONE[c.tone]
          )}
        >
          {c.text}
        </span>
      ))}
      {view.sale && <p className="text-[12.5px] font-semibold text-success-text">{view.sale}</p>}
      {view.note && <p className="text-[12.5px] text-text-2">{view.note}</p>}
      {interactive && (view.primary || view.secondary.length > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {view.primary && renderAction(view.primary, true)}
          {view.secondary.map((a) => renderAction(a, false))}
        </div>
      )}
    </article>
  );
}
