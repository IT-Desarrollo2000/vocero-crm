"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, UserPlus, X } from "lucide-react";
import type { ContactDto, ContactsPageDto } from "@/lib/types";
import { cn, formatPhone } from "@/lib/utils";
import { CHANNEL_LABEL, profileNameCaption } from "@/lib/channels";
import { contactRowView, type RowAction, type RowTone } from "@/lib/contact-row";
import { keepClockTogether, type CardViewer } from "@/lib/pipeline-card";
import { ContactAvatar } from "@/components/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useViewer } from "@/components/viewer-context";
import { SOURCE_LABELS } from "@/server/contact-source";
import { priorityRank } from "@/server/leads/priority";
import { PriorityBadge } from "@/components/pipeline/priority-picker";
import { useStages } from "@/components/use-stages";
import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from "@/lib/pagination";
import { stageColorByName } from "@/lib/stage-colors";
import { takeChat } from "@/lib/take-chat";
import { NewContactDialog } from "./new-contact-dialog";
import { StartConversation } from "./start-conversation";

/** Contactos por página del directorio ("Cargar más" pide otros tantos). */
const PAGE_SIZE = PAGE_DEFAULT_LIMIT;

/** 032 — «Activos / Archivados»: filtro real, no suma (decisión 3). */
type Segment = "active" | "archived";
const SEGMENTS: readonly Segment[] = ["active", "archived"];
const SEGMENT_LABEL: Record<Segment, string> = {
  active: "Activos",
  archived: "Archivados",
};

/** Lo que pasó con la última acción de la lista (archivar, editar). */
type Notice =
  | { kind: "archived" | "restored"; id: string; name: string }
  | { kind: "error"; text: string };

/** Cuánto se queda a la vista el aviso «Archivaste a X · Deshacer». */
const NOTICE_MS = 10_000;

/**
 * A quién llamar primero: alta arriba, sin prioridad al final. El orden lo
 * decide esta lista, no el servidor, porque es una preferencia de trabajo y no
 * un dato del contacto. Se aplica a lo YA cargado: "Cargar más" puede
 * intercalar contactos con prioridad entre los anteriores.
 */
function byPriority(list: ContactDto[]): ContactDto[] {
  return [...list].sort(
    (a, b) => priorityRank(a.priority ?? null) - priorityRank(b.priority ?? null)
  );
}

async function errorMessage(res: Response | null): Promise<string | null> {
  if (!res) return "sin conexión con el servidor";
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return data?.error?.message ?? null;
}

export function ContactsClient() {
  const router = useRouter();
  const me = useViewer();
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  // Paginado del servidor: cuántos hay en total con estos filtros y desde
  // dónde pedir la siguiente página (null = ya no hay más).
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** `loading` hasta la primera respuesta; `error` si la primera falló. */
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  /** Una recarga posterior falló: la lista sigue, pero se avisa. */
  const [staleList, setStaleList] = useState(false);
  const [counts, setCounts] = useState<ContactsPageDto["counts"] | null>(null);
  const [teamMode, setTeamMode] = useState(true);
  const [tz, setTz] = useState("America/Mexico_City");
  const [now, setNow] = useState(() => Date.now());
  // Cada recarga de la primera página invalida lo que siga en vuelo: una
  // respuesta tardía no debe pisar ni mezclarse con la lista nueva.
  const requestId = useRef(0);
  const loadedCount = useRef(0);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const { stages: pipelineStages } = useStages();
  const stages = pipelineStages.map((s) => s.name);
  const [segment, setSegmentState] = useState<Segment>("active");
  const [editing, setEditing] = useState<ContactDto | null>(null);
  const [creando, setCreando] = useState(false);
  const [escribiendo, setEscribiendo] = useState<ContactDto | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [takingId, setTakingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mismo rescate que en la Bandeja: lo tecleado antes de que hidrate el JS
  // se perdía en silencio. Ver conversation-list.tsx.
  useEffect(() => {
    const typed = inputRef.current?.value ?? "";
    if (typed) setQuery(typed);
  }, []);

  // «Te escribió hace 12 min · … 23 h más» avanza con el reloj, sin pedir nada.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // El aviso de archivar se va solo; el de error se queda hasta cerrarlo.
  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const fetchPage = useCallback(
    async (offset: number, limit: number) => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (stage !== "all") params.set("stage", stage);
      params.set("archived", segment === "archived" ? "only" : "exclude");
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const res = await fetch(`/api/contacts?${params}`).catch(() => null);
      if (!res?.ok) return null;
      return (await res.json().catch(() => null)) as ContactsPageDto | null;
    },
    [query, stage, segment]
  );

  /**
   * Primera página: REEMPLAZA la lista. `keep` pide al menos esa cantidad
   * para que archivar o editar en la página 3 no lo regrese a la 1.
   */
  const refetch = useCallback(
    async (keep = 0) => {
      const id = ++requestId.current;
      const limit = Math.min(PAGE_MAX_LIMIT, Math.max(PAGE_SIZE, keep));
      const data = await fetchPage(0, limit);
      if (id !== requestId.current) return;
      if (!data) {
        // Sin datos nunca se pinta «Sin contactos»: eso sería mentir.
        setStatus((s) => (s === "ready" ? s : "error"));
        setStaleList(true);
        return;
      }
      loadedCount.current = data.contacts.length;
      setContacts(byPriority(data.contacts));
      setTotal(data.total ?? data.contacts.length);
      setNextOffset(data.nextOffset ?? null);
      if (data.counts) setCounts(data.counts);
      if (typeof data.teamMode === "boolean") setTeamMode(data.teamMode);
      if (data.businessTimezone) setTz(data.businessTimezone);
      setNow(Date.now());
      setStaleList(false);
      setStatus("ready");
    },
    [fetchPage]
  );

  /** Siguiente página: se AGREGA a lo que ya está en pantalla. */
  async function loadMore() {
    if (nextOffset === null || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    const data = await fetchPage(nextOffset, PAGE_SIZE);
    setLoadingMore(false);
    if (id !== requestId.current) return;
    if (!data) {
      setStaleList(true);
      return;
    }
    setContacts((prev) => {
      // Si alguien escribió mientras se paginaba, su contacto subió al
      // principio y el offset repite uno: se descarta por `id`.
      const seen = new Set(prev.map((c) => c.id));
      const merged = byPriority([
        ...prev,
        ...data.contacts.filter((c) => !seen.has(c.id)),
      ]);
      loadedCount.current = merged.length;
      return merged;
    });
    setTotal(data.total ?? total);
    setNextOffset(data.nextOffset ?? null);
  }

  useEffect(() => {
    const t = setTimeout(() => void refetch(), 250);
    return () => clearTimeout(t);
  }, [refetch]);

  /**
   * Cambiar de pestaña vacía la lista al instante: los activos no deben
   * quedarse a la vista bajo «Archivados» mientras llega la respuesta.
   */
  function setSegment(next: Segment) {
    if (next === segment) return;
    requestId.current++;
    setSegmentState(next);
    setContacts([]);
    setNextOffset(null);
    loadedCount.current = 0;
    setStatus("loading");
    setStaleList(false);
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const failure = res?.ok ? null : ((await errorMessage(res)) ?? "no se pudo guardar");
    void refetch(loadedCount.current);
    return failure;
  }

  async function setArchived(c: { id: string; name: string }, archived: boolean) {
    setBusyId(c.id);
    const failure = await patch(c.id, { archived });
    setBusyId(null);
    if (failure) {
      setNotice({
        kind: "error",
        text: `No se pudo ${archived ? "archivar" : "desarchivar"} a ${c.name}: ${failure}.`,
      });
      return;
    }
    setNotice({ kind: archived ? "archived" : "restored", id: c.id, name: c.name });
  }

  /**
   * «Tomar y responder»: la misma toma que Seguimiento (`takeChat`). Si otro
   * se adelantó, se dice quién y la lista vuelve a la verdad del servidor.
   */
  async function tomar(c: ContactDto, conversationId: string) {
    setTakingId(c.id);
    const result = await takeChat(conversationId, me.userId, c.name);
    setTakingId(null);
    if (result.ok) {
      router.push(`/inbox?contact=${c.id}`);
      return;
    }
    setNotice({ kind: "error", text: result.message });
    void refetch(loadedCount.current);
  }

  /** «Deshacer»: el cambio contrario, con su propio aviso si falla. */
  async function undo(n: Extract<Notice, { id: string }>) {
    setNotice(null);
    const archived = n.kind === "restored";
    const failure = await patch(n.id, { archived });
    if (failure) {
      setNotice({ kind: "error", text: `No se pudo deshacer el cambio de ${n.name}: ${failure}.` });
    }
  }

  const rowViewer: CardViewer = useMemo(
    () => ({ userId: me.userId, role: me.role, teamMode }),
    [me.userId, me.role, teamMode]
  );

  const filtered = query.trim() !== "" || stage !== "all";

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Contactos</h2>
          <Button size="sm" onClick={() => setCreando(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
            Nuevo contacto
          </Button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Buscar por nombre o teléfono…"
              aria-label="Buscar contacto"
              defaultValue=""
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 sm:w-72"
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <div
            role="group"
            aria-label="Qué contactos ver"
            className="inline-flex flex-wrap gap-1 rounded-lg bg-secondary p-[3px]"
          >
            {SEGMENTS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={segment === s}
                onClick={() => setSegment(s)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  segment === s
                    ? "bg-background font-semibold text-foreground shadow-sm"
                    : "text-text-2 hover:text-foreground"
                )}
              >
                {SEGMENT_LABEL[s]}
                {counts ? ` · ${s === "active" ? counts.active : counts.archived}` : ""}
              </button>
            ))}
          </div>
          {stages.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-text-2">
              {/* Rótulo visible; el nombre accesible sigue siendo el del
                  `aria-label` (lo citan los E2E). */}
              <span aria-hidden>Etapa</span>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                aria-label="Filtrar por etapa del embudo"
                className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
              >
                <option value="all">Toda etapa</option>
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>

        {notice && <NoticeBar notice={notice} onUndo={undo} onClose={() => setNotice(null)} />}

        {status === "ready" && staleList && (
          <div
            role="status"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text"
          >
            <p className="min-w-0 flex-1">
              No se pudo actualizar la lista; lo que ves puede estar atrasado.
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch(loadedCount.current)}>
              Reintentar
            </Button>
          </div>
        )}

        {status === "loading" && <ListSkeleton />}

        {status === "error" && (
          <div
            role="alert"
            className="mx-auto mt-8 w-full max-w-md space-y-3 rounded-lg border bg-card p-5 text-center"
          >
            <p className="font-semibold">No se pudieron cargar los contactos.</p>
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

        {status === "ready" && contacts.length === 0 && (
          <EmptyState segment={segment} filtered={filtered} query={query.trim()} stage={stage} />
        )}

        {status === "ready" && contacts.length > 0 && (
          <ul className="space-y-2">
            {contacts.map((c) => (
              <ContactRow
                key={c.id}
                contact={c}
                viewer={rowViewer}
                now={now}
                tz={tz}
                stages={pipelineStages}
                busy={busyId === c.id}
                onEdit={() => setEditing(c)}
                taking={takingId === c.id}
                onWriteFirst={() => setEscribiendo(c)}
                onTake={(conversationId) => void tomar(c, conversationId)}
                onToggleArchive={() => void setArchived(c, !c.archivedAt)}
              />
            ))}
          </ul>
        )}
        {status === "ready" && contacts.length > 0 && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Mostrando {contacts.length} de {Math.max(total, contacts.length)}
            </p>
            {nextOffset !== null && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Cargando…" : "Cargar más"}
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <EditDialog
          contact={editing}
          onClose={() => setEditing(null)}
          onSave={async (patchBody) => {
            const failure = await patch(editing.id, patchBody);
            if (!failure) setEditing(null);
            return failure;
          }}
        />
      )}

      {escribiendo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Escribir primero a ${escribiendo.name}`}
          onClick={() => setEscribiendo(null)}
        >
          <div
            className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-card p-4 shadow-pop sm:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setEscribiendo(null)}>
                Cerrar
              </Button>
            </div>
            <StartConversation
              contactId={escribiendo.id}
              contactName={escribiendo.name}
              onStarted={() => {
                const contactId = escribiendo.id;
                setEscribiendo(null);
                // La Bandeja resuelve por CONTACTO (`?contact=`), no por
                // conversación: con `?conversation=` no seleccionaría nada.
                router.push(`/inbox?contact=${contactId}`);
              }}
            />
          </div>
        </div>
      )}

      {creando && (
        <NewContactDialog
          onClose={() => setCreando(false)}
          onCreated={() => {
            setCreando(false);
            void refetch();
          }}
          onOpenExisting={(contactId) => {
            setCreando(false);
            router.push(`/inbox?contact=${contactId}`);
          }}
        />
      )}
    </div>
  );
}

const PRIMARY_CLS =
  "inline-flex h-8 items-center whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const OUTLINE_CLS =
  "inline-flex h-8 items-center whitespace-nowrap rounded-md border px-3 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const TONE_CLS: Record<RowTone, string> = {
  success: "font-semibold text-success-text",
  warning: "font-semibold text-warning-text",
  neutral: "text-text-2",
};

function ContactRow({
  contact: c,
  viewer,
  now,
  tz,
  stages,
  busy,
  taking,
  onEdit,
  onWriteFirst,
  onTake,
  onToggleArchive,
}: {
  contact: ContactDto;
  viewer: CardViewer;
  now: number;
  tz: string;
  stages: Parameters<typeof stageColorByName>[1];
  busy: boolean;
  taking: boolean;
  onEdit: () => void;
  onWriteFirst: () => void;
  onTake: (conversationId: string) => void;
  onToggleArchive: () => void;
}) {
  const view = contactRowView(
    {
      id: c.id,
      channel: c.channel,
      phone: c.phone,
      conversation: c.conversation ?? null,
    },
    { viewer, now, tz }
  );
  const meta = [
    formatPhone(c.phone),
    CHANNEL_LABEL[c.conversation?.channel ?? c.channel],
    view.who,
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-3 sm:flex-nowrap sm:gap-x-4 sm:px-4">
      <ContactAvatar name={c.name} seed={c.id} />
      {/* El 60% mínimo es lo que empuja los botones a su propio
          renglón en el teléfono en vez de exprimir el nombre. */}
      <div className="min-w-[60%] flex-1 space-y-0.5 sm:min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{c.name}</span>
          {c.priority && <PriorityBadge value={c.priority} />}
          {c.stageName && (
            <Badge variant="outline" className="gap-1.5">
              <span
                aria-hidden
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: stageColorByName(c.stageName, stages) }}
              />
              {c.stageName}
            </Badge>
          )}
          {c.archivedAt && <Badge variant="secondary">Archivado</Badge>}
          {/* Solo la fuente que alguien capturó: presentar una
              deducción como dato la volvería un número inventado en
              cuanto se cuente por fuente. */}
          {c.source?.source === "capturada" && (
            <Badge variant="secondary">{SOURCE_LABELS[c.source.value]}</Badge>
          )}
        </div>
        <ProfileNameLine contact={c} />
        <p className="break-words text-xs text-muted-foreground">{meta.join(" · ")}</p>
        <p
          className={cn("break-words text-[12.5px]", TONE_CLS[view.tone])}
          data-testid="contact-status"
        >
          {keepClockTogether(view.status)}
        </p>
        {c.notes && (
          <p className="truncate text-xs text-text-3">{c.notes.slice(0, 120)}</p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {view.action && (
          <RowActionButton
            action={view.action}
            name={c.name}
            taking={taking}
            onWriteFirst={onWriteFirst}
            onTake={onTake}
          />
        )}
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Editar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`${c.archivedAt ? "Desarchivar" : "Archivar"} a ${c.name}`}
          onClick={onToggleArchive}
        >
          {c.archivedAt ? "Desarchivar" : "Archivar"}
        </Button>
      </div>
    </li>
  );
}

function RowActionButton({
  action,
  name,
  taking,
  onWriteFirst,
  onTake,
}: {
  action: RowAction;
  name: string;
  taking: boolean;
  onWriteFirst: () => void;
  onTake: (conversationId: string) => void;
}) {
  if (action.kind === "take") {
    return (
      <button
        type="button"
        className={cn(PRIMARY_CLS, "disabled:opacity-60")}
        disabled={taking}
        aria-label={`${action.label}: ${name}`}
        onClick={() => onTake(action.conversationId)}
      >
        {taking ? "Tomando…" : action.label}
      </button>
    );
  }
  if (action.kind === "first") {
    return (
      <button
        type="button"
        className={PRIMARY_CLS}
        aria-label={`Escribir primero a ${name}`}
        onClick={onWriteFirst}
      >
        {action.label}
      </button>
    );
  }
  const strong = action.kind === "template" || action.strong;
  return (
    <Link
      href={action.href}
      className={strong ? PRIMARY_CLS : OUTLINE_CLS}
      aria-label={`${action.label}: ${name}`}
    >
      {action.label}
    </Link>
  );
}

function NoticeBar({
  notice,
  onUndo,
  onClose,
}: {
  notice: Notice;
  onUndo: (n: Extract<Notice, { id: string }>) => void;
  onClose: () => void;
}) {
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="mb-3 flex items-start gap-2 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
      >
        <p className="min-w-0 flex-1">{notice.text}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar el aviso"
          className="rounded p-0.5 hover:bg-background/60"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="mb-3 flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-foreground px-3.5 py-2 text-[13px] text-background sm:w-fit"
    >
      <p className="min-w-0">
        {notice.kind === "archived"
          ? `Archivaste a ${notice.name}. Ya no aparece en Activos.`
          : `Desarchivaste a ${notice.name}. Volvió a Activos.`}
      </p>
      <button
        type="button"
        onClick={() => onUndo(notice)}
        className="rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Deshacer
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">Cargando contactos…</span>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} aria-hidden className="h-[76px] animate-pulse rounded-lg border bg-secondary/50" />
      ))}
    </div>
  );
}

function EmptyState({
  segment,
  filtered,
  query,
  stage,
}: {
  segment: Segment;
  filtered: boolean;
  query: string;
  stage: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {filtered ? (
        <>
          <p className="text-sm font-medium">Sin resultados</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {segment === "archived" ? "Ningún archivado coincide con" : "Nadie coincide con"}
            {query ? ` «${query}»` : ""}
            {query && stage !== "all" ? " en" : ""}
            {stage !== "all" ? ` la etapa «${stage}»` : ""}.
          </p>
        </>
      ) : segment === "archived" ? (
        <>
          <p className="text-sm font-medium">No hay contactos archivados</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Cuando archives a alguien desde Activos, aparecerá aquí. Archivar no
            borra nada: puedes desarchivarlo cuando quieras.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">Sin contactos</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Cada persona que escriba a tu WhatsApp quedará registrada aquí
            automáticamente. Para alguien que no te ha escrito, usa «Nuevo contacto».
          </p>
        </>
      )}
    </div>
  );
}

function EditDialog({
  contact,
  onClose,
  onSave,
}: {
  contact: ContactDto;
  onClose: () => void;
  /** Devuelve el motivo si no se guardó (el diálogo se queda abierto). */
  onSave: (patch: { name: string; notes: string }) => Promise<string | null>;
}) {
  const [name, setName] = useState(contact.name);
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockedReason = !name.trim() ? "Escribe un nombre para poder guardar." : null;

  async function save() {
    setSaving(true);
    setError(null);
    const failure = await onSave({ name: name.trim(), notes });
    setSaving(false);
    if (failure) setError(`No se pudo guardar: ${failure}.`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Editar contacto"
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-semibold">Editar contacto</h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="edit-name">
              Nombre
            </label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="edit-notes">
              Notas
            </label>
            <Textarea
              id="edit-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger-text">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={blockedReason !== null || saving}
            aria-describedby={blockedReason ? "edit-blocked-reason" : undefined}
            onClick={() => void save()}
          >
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
        {blockedReason && (
          <p id="edit-blocked-reason" className="mt-2 text-right text-[12.5px] text-text-2">
            {blockedReason}
          </p>
        )}
      </div>
    </div>
  );
}

/** 022: el nombre de perfil del canal, en gris, si difiere del nombre. */
function ProfileNameLine({ contact }: { contact: ContactDto }) {
  const caption = profileNameCaption(contact.channel, contact.name, contact.profileName);
  if (!caption) return null;
  return (
    <p className="truncate text-[11px] text-text-3" data-testid="profile-name">
      {caption}
    </p>
  );
}
