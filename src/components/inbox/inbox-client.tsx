"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, Info, PanelRight, X } from "lucide-react";
import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import type { AssignBody, ConversationDto, MessageDto } from "@/lib/types";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { ChannelBadge } from "@/components/channel-badge";
import { useEvents } from "@/components/use-events";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-thread";
import { Composer } from "./composer";
import { ContactPanel } from "./contact-panel";
import { AssignmentControl, type TeamOption } from "./assignment-control";

/** 09: avisos de asignación (no bloqueantes; el E2E los busca por texto). */
const NOTICE_LOST = "Esta conversación ahora la atiende otro vendedor.";
const NOTICE_LINK = "Esta conversación la atiende otro vendedor o aún no existe.";
const NOTICE_GONE = "Esta conversación ya no está disponible.";
const NOTICE_TAKEN = "Ya la tomó otro vendedor.";

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    assignedTo?: { userId: string; name: string };
  };
} | null;

/**
 * Texto que ya salió del compositor pero cuyo POST todavía viaja. Existe solo
 * en el cliente: se pinta como burbuja "enviando" para que escribir el
 * siguiente renglón no espere a Meta (~1,5 s de ida y vuelta).
 */
type PendingOut = {
  id: string;
  conversationId: string;
  text: string;
  createdAt: string;
};

/**
 * `xl` es el umbral donde caben las tres columnas (lista + hilo + detalles).
 * Debajo, el panel de detalles flota sobre el hilo. Debe coincidir con el
 * breakpoint `xl:` que usan las clases de la sección de detalles.
 */
const PANEL_MEDIA_QUERY = "(min-width: 1280px)";
const isWideEnoughForPanel = () =>
  typeof window !== "undefined" && window.matchMedia(PANEL_MEDIA_QUERY).matches;

export function InboxClient({ channels }: { channels: readonly Channel[] }) {
  const multiChannel = channels.length > 1;
  const [conversations, setConversations] = useState<ConversationDto[] | null>(
    null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [pending, setPending] = useState<PendingOut[]>([]);
  // Arranca cerrado: en pantallas angostas el panel de detalles es un cajón
  // ENCIMA del hilo, así que abrirlo por defecto taparía la conversación. El
  // efecto de abajo lo abre solo si de veras hay tres columnas de ancho.
  const [panelOpen, setPanelOpen] = useState(false);
  // Se incrementa con cada evento SSE que puede cambiar la etapa/lead o el
  // estado del agente: el panel de detalles lo observa y refetch en vivo.
  const [detailRev, setDetailRev] = useState(0);

  useEffect(() => {
    if (!isWideEnoughForPanel()) return;
    setPanelOpen(localStorage.getItem("vocero.panelOpen") !== "false");
  }, []);
  const togglePanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    // La preferencia es de escritorio: abrir el cajón en el teléfono no debe
    // reescribir cómo queda la Bandeja en la computadora.
    if (isWideEnoughForPanel()) {
      localStorage.setItem("vocero.panelOpen", String(open));
    }
  }, []);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const lastFetchRef = useRef<string | null>(null);
  const tmpSeq = useRef(0);
  // Los envíos salen en fila: el compositor ya no espera, pero WhatsApp debe
  // recibir "hola" antes que el renglón siguiente. Sin esta cadena, dos POST
  // simultáneos pueden llegar a Meta en desorden.
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  // 09 — Asignación. La regla de quién ve qué vive en el servidor: aquí solo
  // se refleja (y se reacciona cuando una conversación deja de ser visible).
  const viewer = useViewer();
  const owner = isOwner(viewer);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [team, setTeam] = useState<TeamOption[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Solo el Propietario elige responsable: el equipo es owner-only.
  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    fetch("/api/settings/team")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { members?: TeamOption[] } | null) => {
        if (cancelled || !d?.members) return;
        setTeam(d.members.map((m) => ({ userId: m.userId, name: m.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner]);

  /**
   * La conversación abierta dejó de ser visible (la reasignaron o la tomó
   * otro): se cierra la selección y se avisa sin bloquear. `silentForOwner`:
   * si desaparece de la lista del Propietario no es por asignación (él ve
   * todo), así que no hay nada que explicarle.
   */
  const closeLost = useCallback((id: string, silentForOwner: boolean) => {
    if (selectedIdRef.current !== id) return;
    selectedIdRef.current = null;
    setSelectedId(null);
    setMessages([]);
    if (!ownerRef.current) setNotice(NOTICE_LOST);
    else if (!silentForOwner) setNotice(NOTICE_GONE);
  }, []);

  // Las ráfagas de SSE disparan refetches simultáneos: solo se aplica la
  // respuesta más reciente, para que una lista vieja no "pierda" la abierta.
  const fetchSeq = useRef(0);
  const conversationsRef = useRef<ConversationDto[] | null>(null);
  const refetchConversations = useCallback(async () => {
    const seq = ++fetchSeq.current;
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { conversations: ConversationDto[] };
    if (seq !== fetchSeq.current) return;
    const prev = conversationsRef.current;
    conversationsRef.current = data.conversations;
    setConversations(data.conversations);
    lastFetchRef.current = new Date().toISOString();
    // El servidor no avisa "ya no la ves" (filtraría): se nota porque deja de
    // venir en la lista completa (contrato 09-0).
    const sel = selectedIdRef.current;
    if (
      sel &&
      prev?.some((c) => c.id === sel) &&
      !data.conversations.some((c) => c.id === sel)
    ) {
      closeLost(sel, true);
    }
  }, [closeLost]);

  const refetchMessages = useCallback(
    async (conversationId: string) => {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages`
      ).catch(() => null);
      if (res?.status === 404) {
        closeLost(conversationId, false);
        return;
      }
      if (!res?.ok) return;
      const data = (await res.json()) as { messages: MessageDto[] };
      if (selectedIdRef.current === conversationId) setMessages(data.messages);
    },
    [closeLost]
  );

  const markRead = useCallback(
    async (conversationId: string) => {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markRead: true }),
      }).catch(() => null);
      if (res?.status === 404) closeLost(conversationId, false);
    },
    [closeLost]
  );

  useEffect(() => {
    void refetchConversations();
  }, [refetchConversations]);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMessages([]);
      void refetchMessages(id);
      void markRead(id);
    },
    [refetchMessages, markRead]
  );

  // Enlace directo desde Contactos/Pipeline: /inbox?contact=<id>
  const searchParams = useSearchParams();
  const contactParam = searchParams.get("contact");
  useEffect(() => {
    if (!contactParam || selectedIdRef.current) return;
    const match = conversations?.find((c) => c.contact.id === contactParam);
    if (match) select(match.id);
  }, [contactParam, conversations, select]);

  // 09: si el enlace apunta a una conversación que el Vendedor no ve, se dice
  // por qué en vez de dejar el hilo vacío. Una sola vez por enlace, con la
  // primera lista que llega.
  const linkChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!contactParam || conversations === null) return;
    if (linkChecked.current === contactParam) return;
    linkChecked.current = contactParam;
    const match = conversations.some((c) => c.contact.id === contactParam);
    if (!match && !owner) setNotice(NOTICE_LINK);
  }, [contactParam, conversations, owner]);

  /**
   * 09 — Tomar / liberar / (re)asignar. `POST .../assign` con `AssignBody`;
   * el resultado real llega con el refetch (la lista manda).
   */
  const assign = useCallback(
    async (userId: string | null) => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return;
      const body: AssignBody = { userId };
      const res = await fetch(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res) {
        setNotice("Sin conexión con el servidor.");
      } else if (res.status === 404) {
        closeLost(conversationId, false);
      } else if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ApiErrorBody;
        const code = data?.error?.code;
        if (code === "already_assigned") {
          const who = data?.error?.assignedTo?.name;
          setNotice(who ? `Ya la tomó ${who}.` : NOTICE_TAKEN);
          // El Vendedor ya no puede verla: se cierra aquí, antes del refetch,
          // para que el aviso sea este y no el genérico de "perdiste acceso".
          if (!ownerRef.current && selectedIdRef.current === conversationId) {
            selectedIdRef.current = null;
            setSelectedId(null);
            setMessages([]);
          }
        } else if (res.status === 501) {
          setNotice("La asignación todavía no está disponible en este servidor.");
        } else {
          setNotice(data?.error?.message ?? "No se pudo cambiar el responsable.");
        }
      }
      await refetchConversations();
    },
    [closeLost, refetchConversations]
  );

  useEvents({
    onMessageNew: ({ conversationId, message }) => {
      if (selectedIdRef.current === conversationId) {
        const m = message as MessageDto;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m]
        );
        void markRead(conversationId);
      }
      void refetchConversations();
      // Un entrante nuevo puede crear/mover el lead: refresca el panel.
      setDetailRev((v) => v + 1);
    },
    onMessageStatus: ({ conversationId, messageId, status, error }) => {
      if (selectedIdRef.current !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: status as MessageDto["status"],
                error: error ?? null,
              }
            : m
        )
      );
    },
    onConversationUpdated: () => {
      void refetchConversations();
      // El agente movió de etapa o cambió el handoff: refresca el panel en vivo.
      setDetailRev((v) => v + 1);
    },
    onReconnect: () => {
      // Catch-up tras reconexión (contrato sse.md): refetch completo.
      void refetchConversations();
      if (selectedIdRef.current) void refetchMessages(selectedIdRef.current);
      setDetailRev((v) => v + 1);
    },
  });

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  /**
   * Hilo visible = lo confirmado + lo que aún viaja. El mensaje real puede
   * llegar por refetch o por SSE antes de que retiremos el provisional, así
   * que cada pendiente se empareja con UN mensaje real (no por texto suelto:
   * mandar "hola" dos veces seguidas no debe borrar la segunda burbuja).
   */
  const thread = useMemo(() => {
    const propios = pending.filter((p) => p.conversationId === selectedId);
    if (propios.length === 0) return messages;
    const emparejados = new Set<string>();
    const visibles = propios.filter((p) => {
      const real = messages.find(
        (m) =>
          !emparejados.has(m.id) &&
          m.direction === "out" &&
          m.text === p.text &&
          Date.parse(m.createdAt) >= Date.parse(p.createdAt) - 60_000
      );
      if (real) emparejados.add(real.id);
      return !real;
    });
    if (visibles.length === 0) return messages;
    return [
      ...messages,
      ...visibles.map<MessageDto>((p) => ({
        id: p.id,
        conversationId: p.conversationId,
        direction: "out",
        type: "text",
        text: p.text,
        status: "pending",
        error: null,
        aiGenerated: false,
        origin: "operator",
        media: null,
        createdAt: p.createdAt,
      })),
    ];
  }, [messages, pending, selectedId]);

  /**
   * El compositor NO espera a que esto termine: limpia su campo al instante y
   * aquí se pinta la burbuja "enviando". Si el envío falla, la burbuja se
   * retira y el error vuelve al compositor, que devuelve el texto — un mensaje
   * jamás se pierde en silencio.
   */
  const sendText = useCallback(
    async (text: string): Promise<string | null> => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return "Sin conversación seleccionada";

      const tmpId = `tmp_${++tmpSeq.current}`;
      setPending((prev) => [
        ...prev,
        {
          id: tmpId,
          conversationId,
          text,
          createdAt: new Date().toISOString(),
        },
      ]);
      const drop = () => setPending((prev) => prev.filter((p) => p.id !== tmpId));

      const run = async (): Promise<string | null> => {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).catch(() => null);
        if (!res) {
          drop();
          return "Sin conexión con el servidor";
        }
        if (res.status === 404) {
          // 09: otro vendedor la tomó entre que se abrió y se envió; el
          // mensaje NO salió (el reclamo es la compuerta del envío).
          drop();
          closeLost(conversationId, false);
          return NOTICE_LOST;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          drop();
          return data?.error?.message ?? "No se pudo enviar el mensaje";
        }
        // Primero traer el mensaje real, después quitar el provisional: al
        // revés, la burbuja parpadearía.
        await refetchMessages(conversationId);
        drop();
        void refetchConversations();
        return null;
      };

      const queued = sendQueue.current.then(run, run);
      sendQueue.current = queued.catch(() => null);
      return queued;
    },
    [refetchMessages, refetchConversations, closeLost]
  );

  const patchConversation = useCallback(
    async (patch: { aiEnabled?: boolean; reactivate?: boolean }) => {
      const conversationId = selectedIdRef.current;
      if (!conversationId) return;
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => null);
      if (res?.status === 404) closeLost(conversationId, false);
      void refetchConversations();
    },
    [refetchConversations, closeLost]
  );

  /**
   * 09: la asignación solo se enseña si hay equipo. Con el Propietario solo
   * (instancia de un usuario) la Bandeja queda exactamente como antes; el
   * Vendedor, por definición, trabaja en equipo.
   */
  const teamMode =
    !owner ||
    (team?.length ?? 0) > 1 ||
    (conversations?.some((c) => c.assignedTo !== null) ?? false);

  const assignmentControl = (className?: string) =>
    selected && teamMode ? (
      <AssignmentControl
        conversation={selected}
        owner={owner}
        viewerId={viewer.userId}
        team={team}
        onAssign={assign}
        className={className}
      />
    ) : null;

  return (
    <div className="flex h-full">
      {/* Móvil: una columna a la vez. La lista cede la pantalla completa al
          hilo en cuanto hay conversación elegida (patrón maestro-detalle). */}
      <section
        className={cn(
          "w-full shrink-0 overflow-hidden border-r md:w-[300px] lg:w-[360px]",
          selected && "max-md:hidden"
        )}
      >
        <ConversationList
          conversations={conversations}
          channels={channels}
          selectedId={selectedId}
          onSelect={select}
          onSeeded={() => void refetchConversations()}
          teamMode={teamMode}
        />
      </section>

      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          !selected && "max-md:hidden"
        )}
      >
        {selected ? (
          <>
            <header className="flex items-center justify-between gap-1 border-b bg-background px-2 py-2.5 md:px-4">
              {/* Volver a la lista: en móvil el hilo ocupa toda la pantalla. */}
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Volver a las conversaciones"
                className="shrink-0 rounded-md p-1.5 text-text-2 hover:bg-accent hover:text-foreground md:hidden"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-3 p-1">
                <ContactAvatar
                  name={selected.contact.name}
                  seed={selected.contact.id}
                  size="md"
                />
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-[650] leading-tight">
                    {multiChannel && <ChannelBadge channel={selected.channel} />}
                    <span className="truncate">{selected.contact.name}</span>
                  </p>
                  <p
                    className={
                      selected.windowOpen
                        ? "text-xs font-medium text-success"
                        : "text-xs text-text-3"
                    }
                  >
                    {selected.windowOpen
                      ? "ventana abierta"
                      : selected.contact.phone
                        ? formatPhone(selected.contact.phone)
                        : // Instagram no tiene teléfono: decir "Sin teléfono"
                          // sería contestar una pregunta que nadie hizo.
                          CHANNEL_LABEL[selected.channel]}
                  </p>
                </div>
              </div>
              {/* 09: el control de responsable vive en UN solo lugar a la
                  vez — aquí con el panel cerrado, en el panel si está
                  abierto — para que sus aria-label no se repitan. */}
              {!panelOpen && assignmentControl()}
              {!panelOpen && (
                <button
                  onClick={() => togglePanel(true)}
                  aria-label="Mostrar detalles"
                  className="shrink-0 rounded-sm border p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.7} />
                </button>
              )}
            </header>
            <MessageThread messages={thread} />
            <Composer
              conversation={selected}
              onNotVisible={() => closeLost(selected.id, false)}
              onSend={sendText}
              onSent={() => {
                if (selectedIdRef.current)
                  void refetchMessages(selectedIdRef.current);
                void refetchConversations();
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-chat text-sm text-text-3">
            Elige una conversación para ver el hilo
          </div>
        )}
      </section>

      {/* Velo del cajón de detalles (solo donde no caben tres columnas). */}
      {panelOpen && selected && (
        <button
          aria-label="Cerrar los detalles"
          tabIndex={-1}
          onClick={() => togglePanel(false)}
          className="fixed inset-0 z-30 bg-overlay xl:hidden"
        />
      )}

      <section
        className={cn(
          "shrink-0 overflow-hidden border-l transition-[width] duration-[220ms]",
          // Debajo de xl no hay ancho para una tercera columna: el panel se
          // vuelve un cajón que entra desde la derecha, encima del hilo.
          "max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:w-auto max-xl:bg-background max-xl:transition-transform",
          panelOpen && selected
            ? "w-[320px] max-xl:translate-x-0 max-xl:shadow-pop"
            : "w-0 border-l-0 max-xl:translate-x-full"
        )}
      >
        {selected && (
          <div className="h-full w-[320px] max-xl:w-[min(320px,88vw)]">
            <ContactPanel
              conversation={selected}
              refreshKey={detailRev}
              onPatchConversation={patchConversation}
              onClose={() => togglePanel(false)}
              assignment={panelOpen ? assignmentControl("max-w-none") : null}
            />
          </div>
        )}
      </section>

      {/* 09: aviso no bloqueante (pérdida de acceso, carrera al tomar…). */}
      {notice && (
        <div
          role="status"
          className="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-md items-start gap-2 rounded-md border bg-background px-3 py-2.5 text-sm shadow-pop md:bottom-6"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.7} />
          <p className="flex-1">{notice}</p>
          <button
            onClick={() => setNotice(null)}
            aria-label="Cerrar aviso"
            className="shrink-0 rounded p-0.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
