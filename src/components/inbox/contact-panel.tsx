"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Sparkles, UserRound } from "lucide-react";
import type {
  AnuncioDto,
  ConversationDto,
  FichaDto,
  FichaValue,
  SourceDto,
  SourceValue,
  StageDto,
} from "@/lib/types";
import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FichaPanel } from "@/components/ficha-panel";
import { applyHumanPatch, applyUnlock } from "@/components/ficha-view";
import type { FichaFieldDef, FichaMeta } from "@/lib/ficha-fields";
import { handoffLabel } from "@/lib/handoff-labels";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import { AnuncioOrigen } from "@/components/anuncio-origen";
import { SOURCE_LABELS, SOURCE_VALUES } from "@/server/contact-source";

/**
 * 020 (D3) — Fuente del prospecto, editable. "Automática" = la deducida (el
 * anuncio de origen, o "sin identificar"); elegir un valor la captura a mano
 * y manda sobre la deducción.
 */
export function SourcePicker({
  source,
  onChange,
}: {
  source: SourceDto | null;
  onChange: (value: SourceValue | null) => void;
}) {
  const captured = source?.source === "capturada";
  const deducedLabel = SOURCE_LABELS[!captured && source ? source.value : "desconocida"];
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">Fuente</p>
        <p className="text-[11px] text-text-3" data-testid="source-kind">
          {source ? (captured ? "Capturada a mano" : "Deducida") : "…"}
        </p>
      </div>
      <select
        aria-label="Fuente del contacto"
        disabled={!source}
        value={captured && source ? source.value : ""}
        onChange={(e) => onChange((e.target.value || null) as SourceValue | null)}
        className="min-w-0 max-w-[60%] truncate rounded-md border bg-background px-2 py-[5px] text-[12.5px]"
      >
        <option value="">
          {captured ? "Automática" : `Automática · ${deducedLabel}`}
        </option>
        {SOURCE_VALUES.map((v) => (
          <option key={v} value={v}>
            {SOURCE_LABELS[v]}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ContactPanel({
  conversation,
  refreshKey = 0,
  onPatchConversation,
  onClose,
  assignment = null,
}: {
  conversation: ConversationDto;
  /**
   * 09: control "Responsable" (selector del Propietario o Tomar/Liberar del
   * Vendedor). Lo arma la Bandeja; null = no se muestra la fila.
   */
  assignment?: React.ReactNode;
  /** Aumenta con cada evento SSE relevante: dispara un refetch en vivo. */
  refreshKey?: number;
  onPatchConversation: (patch: {
    aiEnabled?: boolean;
    reactivate?: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [ficha, setFicha] = useState<FichaDto>({});
  // 04: definición de campos (null = ficha libre) y procedencia por clave.
  const [fichaFields, setFichaFields] = useState<FichaFieldDef[] | null>(null);
  const [fichaMeta, setFichaMeta] = useState<FichaMeta>({});
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [stages, setStages] = useState<StageDto[]>([]);
  const [currentStageId, setCurrentStageId] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  // 020: anuncio de origen (null = no vino de uno) y fuente del prospecto.
  const [anuncio, setAnuncio] = useState<AnuncioDto | null>(null);
  const [source, setSource] = useState<SourceDto | null>(null);
  // Estado global del agente: sin esto, el toggle "Respondiendo" mentiría
  // cuando el agente aún no se ha configurado/encendido.
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);

  const contactId = conversation.contact.id;
  // El Vendedor no configura el agente (dev-tasks/00, RF-00-09): ve el aviso,
  // pero sin el enlace a /agent, que para él es un 404.
  const viewer = useViewer();
  const owner = isOwner(viewer);
  const viewerId = viewer.userId;

  const agentReady = aiConfigured && agentEnabled;
  // El control es la FUENTE DE VERDAD de la conversación: el agente in-process
  // y cualquier cerebro externo conectado por /api/bot/* respetan este flag,
  // así que el toggle opera siempre — `agentReady` solo matiza el texto.
  const aiActive = conversation.aiEnabled && !conversation.handoffAt;

  // Carga inicial (incluye notas): se re-ejecuta al cambiar de contacto.
  const refetch = useCallback(async () => {
    const [detail, stagesRes, agentRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/pipeline/stages").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null, null]);
    if (detail) {
      setNotes(detail.contact?.notes ?? "");
      setFicha(detail.contact?.ficha ?? {});
      setFichaMeta(detail.contact?.fichaMeta ?? {});
      setFichaFields(detail.fichaFields ?? null);
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
      setAnuncio(detail.anuncio ?? null);
      setSource(detail.contact?.source ?? null);
    }
    if (stagesRes) setStages(stagesRes.stages);
    setAgentEnabled(Boolean(agentRes?.profile?.enabled));
    setAiConfigured(Boolean(agentRes?.aiConfigured));
    setNotesLoaded(true);
  }, [contactId]);

  // Refetch en vivo (etapa/lead + estado del agente) SIN tocar las notas, para
  // no pisar lo que el operador esté escribiendo. Lo dispara el SSE.
  const refreshLive = useCallback(async () => {
    const [detail, agentRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null]);
    if (detail) {
      // La ficha SÍ se refresca en vivo: el agente la va llenando mientras la
      // conversación ocurre, y verla aparecer sola es justo para lo que sirve.
      // No pisa una edición a medias — el borrador vive dentro del panel.
      setFicha(detail.contact?.ficha ?? {});
      setFichaMeta(detail.contact?.fichaMeta ?? {});
      setFichaFields(detail.fichaFields ?? null);
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
      // 020: la miniatura llega después (se copia en segundo plano): el
      // evento de la Bandeja la trae sola.
      setAnuncio(detail.anuncio ?? null);
      setSource(detail.contact?.source ?? null);
    }
    if (agentRes) {
      setAgentEnabled(Boolean(agentRes.profile?.enabled));
      setAiConfigured(Boolean(agentRes.aiConfigured));
    }
  }, [contactId]);

  useEffect(() => {
    setNotesLoaded(false);
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!notesLoaded) return; // la carga inicial ya trae el estado fresco
    void refreshLive();
  }, [refreshKey, notesLoaded, refreshLive]);

  async function moveToStage(stageId: string) {
    if (!leadId || stageId === currentStageId) return;
    setCurrentStageId(stageId); // optimista
    await fetch(`/api/pipeline/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId, position: 0 }),
    }).catch(() => null);
    void refreshLive();
  }

  /** Manda SOLO lo que cambió: el servidor hace merge (ver `server/bot/ficha`). */
  async function saveFicha(patch: Record<string, FichaValue | null>) {
    // Optimista: lo escrito queda con candado; el refetch de abajo confirma.
    const next = applyHumanPatch(ficha, fichaMeta, patch, new Date().toISOString());
    setFicha(next.ficha);
    setFichaMeta(next.meta);
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ficha: patch }),
    }).catch(() => null);
    void refreshLive();
  }

  /** Quita el candado sin borrar el valor: el agente vuelve a poder corregirlo. */
  async function unlockFicha(key: string) {
    setFichaMeta(applyUnlock(ficha, fichaMeta, [key], new Date().toISOString()));
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fichaUnlock: [key] }),
    }).catch(() => null);
    void refreshLive();
  }

  /** 020 (D3): `null` vuelve a la fuente deducida. */
  async function saveSource(value: SourceValue | null) {
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: value }),
    }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.contact?.source) setSource(data.contact.source);
  }

  async function saveNotes() {
    setSavingNotes(true);
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    }).catch(() => null);
    setSavingNotes(false);
  }

  const currentIndex = stages.findIndex((s) => s.id === currentStageId);

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 flex items-center justify-between border-b bg-background px-4 py-3">
        <h3 className="text-[13px] font-[650] uppercase tracking-wide text-text-2">
          Detalles
        </h3>
        <button
          onClick={onClose}
          aria-label="Ocultar panel"
          className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Contacto */}
        <section className="border-b p-4">
          <div className="flex items-center gap-3">
            <ContactAvatar
              name={conversation.contact.name}
              seed={conversation.contact.id}
              size="md"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-[650]">
                {conversation.contact.name}
              </p>
              <p className="text-xs text-text-3">
                {formatPhone(conversation.contact.phone)}
              </p>
            </div>
          </div>

          {assignment && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Responsable</p>
                <p className="truncate text-[11px] text-text-3">
                  {conversation.assignedTo
                    ? conversation.assignedTo.userId === viewerId
                      ? "La atiendes tú"
                      : conversation.assignedTo.name
                    : "Sin asignar"}
                </p>
              </div>
              <div className="min-w-0 shrink">{assignment}</div>
            </div>
          )}

          {conversation.handoffAt && (
            <div className="mt-3 rounded-md border border-warning-soft bg-warning-tint p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-warning-text">
                <UserRound className="h-4 w-4" strokeWidth={1.7} /> Atención humana
              </p>
              <p className="mt-1 text-xs text-warning-text opacity-80">
                {handoffLabel(conversation.handoffReason)}
              </p>
              {conversation.handoffNote && (
                // Texto del modelo o del bot: va como texto (React lo
                // escapa), jamás como HTML.
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] italic text-text-3">
                  «{conversation.handoffNote}»
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => void onPatchConversation({ reactivate: true })}
              >
                Reactivar IA
              </Button>
            </div>
          )}

          <div className="mt-3 rounded-md border bg-secondary/50 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">IA en esta conversación</p>
                <p className="text-[11px] text-text-3">
                  {conversation.handoffAt
                    ? "En pausa · atención humana"
                    : !conversation.aiEnabled
                      ? "En pausa"
                      : agentReady
                        ? "Respondiendo"
                        : "Activada"}
                </p>
              </div>
              <button
                role="switch"
                aria-checked={aiActive}
                aria-label="IA en esta conversación"
                onClick={() => {
                  void onPatchConversation({
                    aiEnabled: !conversation.aiEnabled,
                  });
                }}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors",
                  aiActive ? "bg-brand" : "bg-border-strong"
                )}
              >
                <span
                  className={cn(
                    "h-4 w-4 rounded-full bg-knob shadow-sm transition-transform",
                    aiActive ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {!agentReady && (
              <div className="mt-2.5 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-2.5">
                <Sparkles
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-text"
                  strokeWidth={1.7}
                />
                <p className="text-[11px] leading-relaxed text-warning-text">
                  {aiConfigured
                    ? owner
                      ? "El agente de Vocero no responde por su cuenta. Configura lo básico y enciéndelo (o conecta tu propio bot por la API)."
                      : "El agente de Vocero no responde por su cuenta. Pídele al Propietario que lo configure y lo encienda."
                    : owner
                      ? "Falta la clave de IA de la instancia (OPENROUTER_API_TOKEN) para que el agente responda, o conecta tu propio bot por la API."
                      : "El agente de IA no está disponible en esta instancia. Pídele al Propietario que lo configure."}
                  {aiConfigured && owner && (
                    <Link
                      href="/agent"
                      className="ml-1 whitespace-nowrap font-medium text-brand-text underline underline-offset-2 hover:text-brand"
                    >
                      Configurar agente →
                    </Link>
                  )}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Stepper de etapa */}
        {stages.length > 0 && leadId && (
          <section className="border-b p-4">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-text-3">
              Etapa del pipeline
            </p>
            <ol>
              {stages.map((s, i) => {
                const done = currentIndex >= 0 && i < currentIndex;
                const current = s.id === currentStageId;
                return (
                  <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < stages.length - 1 && (
                      <span
                        className={cn(
                          "absolute left-[7px] top-4 h-full w-px",
                          done ? "bg-brand" : "bg-border-strong"
                        )}
                      />
                    )}
                    <button
                      onClick={() => void moveToStage(s.id)}
                      aria-label={`Mover a ${s.name}`}
                      className={cn(
                        "relative z-10 mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full transition-colors",
                        done && "bg-brand text-brand-fg",
                        current && "bg-brand ring-4 ring-brand-soft",
                        !done && !current && "border border-border-strong bg-background hover:border-brand"
                      )}
                    >
                      {done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </button>
                    <button
                      onClick={() => void moveToStage(s.id)}
                      className={cn(
                        "text-left text-[13px]",
                        current ? "font-[650] text-brand-text" : "text-text-2 hover:text-foreground"
                      )}
                    >
                      {s.name}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* 020: de dónde llegó — tarjeta del anuncio de origen (si vino de
            uno) y la fuente del prospecto, editable (D3). Entre la etapa y la
            Ficha: es lo primero que se pregunta de un lead nuevo. */}
        <section className="space-y-3 border-b p-4" aria-label="Origen del contacto">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
            Origen
          </p>
          {anuncio && <AnuncioOrigen anuncio={anuncio} />}
          <SourcePicker source={source} onChange={(v) => void saveSource(v)} />
        </section>

        {/* Ficha: lo que se SABE del lead. Va antes de Notas —lo que alguien
            OPINA— porque es lo que se consulta a mitad de una conversación. */}
        <FichaPanel
          ficha={ficha}
          fields={fichaFields}
          meta={fichaMeta}
          onSave={saveFicha}
          onUnlock={unlockFicha}
          contactId={contactId}
        />

        {/* Notas */}
        <section className="p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">
            Notas
          </p>
          <Textarea
            rows={5}
            placeholder="Notas internas sobre este contacto…"
            value={notes}
            disabled={!notesLoaded}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={savingNotes || !notesLoaded}
            onClick={() => void saveNotes()}
          >
            {savingNotes ? "Guardando…" : "Guardar notas"}
          </Button>
        </section>
      </div>
    </div>
  );
}
