"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock3,
  MessageSquareText,
  RotateCcw,
} from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import { countVariables } from "@/lib/templates";
import {
  displayFirstName,
  firstMissing,
  greetingPrefill,
  previewSegments,
  templateLabels,
  templateSnippet,
  variableContext,
} from "@/lib/template-fill";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import {
  matchTemplateByText,
  TEMPLATE_DUPLICATE_CODE,
  templateStatusLabel,
  type LastTemplate,
} from "@/lib/template-sent";
import { bubbleTime } from "./helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import { cn } from "@/lib/utils";

/** Círculo numerado de cada paso (acento de la marca). */
function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-fg"
    >
      {n}
    </span>
  );
}

/** Encabezado común de la ventana cerrada (ícono + título + explicación). */
function ClosedHeader({
  id,
  title,
  children,
  tone = "warning",
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  tone?: "warning" | "neutral";
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border",
          tone === "warning"
            ? "border-warning-soft bg-warning-tint text-warning-text"
            : "bg-secondary text-text-2"
        )}
      >
        <Clock3 className="h-4 w-4" strokeWidth={1.7} />
      </span>
      <div className="min-w-0 space-y-0.5">
        <h2 id={id} className="text-[15px] font-semibold leading-snug">
          {title}
        </h2>
        <p className="max-w-[640px] text-[13.5px] text-text-2">{children}</p>
      </div>
    </div>
  );
}

/** Lista numerada de «qué sigue» (sin plantillas, canal cerrado). */
function NextSteps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 text-[13.5px]">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand-text"
          >
            {i + 1}
          </span>
          <span className="pt-px">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Nota verde: si el cliente escribe, se vuelve a poder responder normal. */
function ReopenNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-success-soft bg-success-tint px-3 py-2.5 text-[13px] text-success-text">
      {children}
    </p>
  );
}

/**
 * 033 — El servidor frenó la plantilla porque el mismo mensaje acaba de
 * salir: en lugar del botón de envío, el porqué y la decisión.
 */
function DuplicateWarning({
  message,
  name,
  sending,
  onForce,
  onCancel,
}: {
  message: string;
  name: string | null;
  sending: boolean;
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="template-duplicate-warning"
      className="space-y-2.5 rounded-md border border-warning-soft bg-warning-tint px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-warning-text"
          strokeWidth={1.8}
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-[13.5px] font-semibold text-warning-text">{message}</p>
          <p className="text-[13px] text-text-2">
            Si lo mandas otra vez, le llegará repetido. Mientras {name ?? "el cliente"} no
            conteste, no hace falta reenviarlo.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={sending}>
          Cancelar
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onForce}
          disabled={sending}
          className="border-warning text-warning-text hover:bg-warning-tint hover:text-warning-text"
        >
          {sending ? "Enviando…" : "Enviar de todos modos"}
        </Button>
      </div>
    </div>
  );
}

/** Cierra la frase con punto si no trae ya «.», «!» o «?». */
function withPeriod(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** 033 — El último envío no salió: va arriba de los pasos para reintentar. */
function LastSendFailedNotice({
  last,
  name,
}: {
  last: LastTemplate;
  name: string | null;
}) {
  return (
    <div
      role="alert"
      data-testid="template-last-failed"
      className="flex items-start gap-2.5 rounded-md border border-danger-soft bg-danger-tint px-3 py-2.5"
    >
      <AlertCircle
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-danger-text"
        strokeWidth={1.8}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="text-[13.5px] font-semibold text-danger-text">
          La plantilla de las {bubbleTime(last.createdAt)} no le llegó a{" "}
          {name ?? "este cliente"}.
        </p>
        <p className="text-[13px] text-text-2">
          {withPeriod(last.error ?? "WhatsApp no la aceptó.")} Revísala abajo y vuelve a enviarla.
        </p>
      </div>
    </div>
  );
}

/**
 * 033 — En lugar de los pasos, una vez que la plantilla salió: a quién, a
 * qué hora y cómo va su entrega. Se deriva del hilo, así que sigue al
 * recargar y la ve cualquiera que abra el chat.
 */
function TemplateSentCard({
  last,
  name,
  templateLabel,
  onAnother,
}: {
  last: LastTemplate;
  name: string | null;
  /** Nombre legible de la plantilla, si se reconoce por el texto. */
  templateLabel: string | null;
  onAnother: () => void;
}) {
  return (
    <section
      aria-labelledby="plantilla-enviada-titulo"
      data-testid="template-sent-card"
      data-status={last.status}
      className="flex flex-wrap items-center gap-3 rounded-[10px] border border-brand-soft bg-brand-tint px-4 py-3.5"
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg"
      >
        <Check className="h-[18px] w-[18px]" strokeWidth={2.4} />
      </span>
      <div className="min-w-0 flex-1 basis-[260px] space-y-1">
        <h2 id="plantilla-enviada-titulo" className="text-[15px] font-semibold leading-snug">
          Plantilla enviada a {name ?? "este cliente"} · {bubbleTime(last.createdAt)}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
          {templateLabel && <span className="min-w-0 break-words">«{templateLabel}»</span>}
          <span
            data-testid="template-sent-status"
            className="inline-flex items-center rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-text"
          >
            {templateStatusLabel(last.status)}
          </span>
        </p>
        <p className="text-[13.5px] text-text-2">
          Cuando {name ?? "el cliente"} te conteste, podrás escribirle normal. No hace
          falta enviarla otra vez.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onAnother}>
        Enviar otra plantilla
      </Button>
    </section>
  );
}

/**
 * 031 — Instagram/Messenger pasados 7 días (`replyMode: "closed"`): no hay
 * plantillas, solo esperar a que el cliente vuelva a escribir.
 */
export function ChannelClosedNotice({
  channel,
  contactName,
}: {
  channel: Channel;
  contactName: string;
}) {
  const name = displayFirstName(contactName);
  return (
    <section aria-labelledby="channel-closed-title" className="space-y-3">
      <ClosedHeader id="channel-closed-title" title="Todavía no puedes escribirle">
        Pasaron más de 7 días desde el último mensaje de {name ?? "este cliente"}.{" "}
        {CHANNEL_LABEL[channel]} no deja escribirle hasta que vuelva a escribir, y
        aquí no hay plantillas para retomar.
      </ClosedHeader>
      <ReopenNote>
        Si {name ?? "el cliente"} te vuelve a escribir, este espacio se convierte en
        la caja de texto y podrás responderle normal.
      </ReopenNote>
    </section>
  );
}

/**
 * Resultado de mandar la plantilla: el motivo, si no salió. 033: `duplicate`
 * = el servidor la frenó porque el mismo mensaje acaba de salir (se confirma
 * con `force`).
 */
export type TemplateSendResult =
  | { ok: true; conversationId?: string }
  | { ok: false; duplicate?: false; message: string }
  | { ok: false; duplicate: true; message: string };

/** Opciones del envío: `force` confirma el reenvío tras el aviso de duplicado. */
export type TemplateSendOptions = { force?: boolean };

/** Respuesta de error de las rutas de plantilla → resultado del formulario. */
export function templateSendFailure(
  data: { error?: { code?: string; message?: string } } | null,
  fallback: string
): TemplateSendResult {
  const message = data?.error?.message ?? fallback;
  return data?.error?.code === TEMPLATE_DUPLICATE_CODE
    ? { ok: false, duplicate: true, message }
    : { ok: false, message };
}

/**
 * 031/032 — Los tres pasos de la plantilla: elige el mensaje, completa los
 * espacios (con su contexto y el nombre ya puesto si el cuerpo saluda),
 * revisa la vista previa y envía. Lo comparten la Bandeja (retomar un chat
 * cerrado) y Contactos (escribir primero); cada uno pone su encabezado, su
 * estado sin plantillas, su botón y a dónde se manda.
 */
export function TemplateSteps({
  groupName,
  idPrefix = "template",
  contactName,
  headingId,
  header,
  emptyState,
  submitLabel,
  testId,
  notice,
  send: sendTemplate,
  onSent,
}: {
  /** `name` de los radios: único por pantalla. */
  groupName: string;
  /** Prefijo de los ids de los campos (`template-variable-1`, lo citan los E2E). */
  idPrefix?: string;
  contactName: string;
  /** id del título que da nombre a la sección (`aria-labelledby`). */
  headingId: string;
  header: React.ReactNode;
  /** Sin plantillas aprobadas: qué sigue (ocupa todo el espacio). */
  emptyState: React.ReactNode;
  submitLabel: string;
  testId?: string;
  /** 033: aviso arriba de los pasos (el último envío falló). */
  notice?: React.ReactNode;
  send: (
    templateId: string,
    variables: string[] | undefined,
    options?: TemplateSendOptions
  ) => Promise<TemplateSendResult>;
  onSent: (conversationId: string | undefined) => void;
}) {
  const name = displayFirstName(contactName);
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [variables, setVariables] = useState<string[]>([]);
  // El nombre que pusimos solos en {{1}} (para el aviso «Ya pusimos…»).
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 033: el servidor la frenó por repetida; el texto viene de él.
  const [duplicate, setDuplicate] = useState<string | null>(null);

  const choose = useCallback(
    (t: TemplateDto | null) => {
      setSelectedId(t?.id ?? "");
      setError(null);
      setDuplicate(null);
      if (!t) {
        setVariables([]);
        setPrefilled(null);
        return;
      }
      const count = countVariables(t.body);
      const first = count > 0 ? greetingPrefill(t.body, contactName) : null;
      setVariables(Array.from({ length: count }, (_, i) => (i === 0 && first ? first : "")));
      setPrefilled(first);
    },
    [contactName]
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLoadFailed(false);
    setTemplates(null);
    fetch("/api/templates")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ templates?: TemplateDto[] }>;
      })
      .then((d) => {
        if (cancelled) return;
        const approved = (d.templates ?? []).filter((t) => t.status === "approved");
        setTemplates(approved);
        // Con una sola, ya va elegida.
        if (approved.length === 1) choose(approved[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [choose]);

  useEffect(() => load(), [load]);

  if (loadFailed) {
    return (
      <section aria-labelledby={headingId} className="space-y-3">
        {header}
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-danger-soft bg-danger-tint px-3 py-2.5 text-[13px] text-danger-text"
        >
          <p className="min-w-0 flex-1">No se pudieron cargar las plantillas.</p>
          <Button size="sm" variant="outline" onClick={() => load()}>
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
            Reintentar
          </Button>
        </div>
      </section>
    );
  }

  if (templates === null) {
    return (
      <section aria-labelledby={headingId} className="space-y-3" aria-busy="true">
        {header}
        <p role="status" className="text-[13px] text-text-3">
          Cargando plantillas…
        </p>
      </section>
    );
  }

  if (templates.length === 0) return <>{emptyState}</>;

  const labels = templateLabels(templates);
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  // El cuerpo puede llevar {{1}}..{{n}}: el número de parámetros es el índice
  // más alto, y Meta los exige todos.
  const variableCount = selected ? countVariables(selected.body) : 0;
  const values = Array.from({ length: variableCount }, (_, i) => variables[i] ?? "");
  const missing = firstMissing(values);
  const blockedReason = !selected
    ? "Elige un mensaje para poder enviarlo."
    : missing !== null
      ? `Llena el espacio ${missing} para poder enviarla.`
      : null;
  const showPrefillNote = prefilled !== null && values[0] === prefilled;
  const blockedId = `${idPrefix}-blocked-reason`;

  async function send(force = false) {
    if (!selected || sending || blockedReason) return;
    setSending(true);
    setError(null);
    const result = await sendTemplate(
      selected.id,
      variableCount > 0 ? values : undefined,
      force ? { force: true } : undefined
    );
    setSending(false);
    if (!result.ok) {
      if (result.duplicate) setDuplicate(result.message);
      else {
        setDuplicate(null);
        setError(result.message);
      }
      return;
    }
    setDuplicate(null);
    choose(templates && templates.length === 1 ? (templates[0] ?? null) : null);
    onSent(result.conversationId);
  }

  return (
    <section aria-labelledby={headingId} data-testid={testId} className="space-y-4">
      {header}
      {notice}

      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 flex-1 basis-[340px] space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <StepBadge n={1} />
              Elige el mensaje
            </legend>
            {templates.map((t) => {
              const on = t.id === selectedId;
              return (
                <label
                  key={t.id}
                  data-testid="template-option"
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    on ? "border-brand bg-brand-tint" : "hover:bg-subtle"
                  )}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={t.id}
                    checked={on}
                    onChange={() => choose(t)}
                    className="mt-1 accent-brand"
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm font-semibold">{labels.get(t.id)}</span>
                    <span className="block break-words text-[12.5px] text-text-2">
                      “{templateSnippet(t.body)}”
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {selected && variableCount > 0 && (
            <fieldset className="space-y-2.5">
              <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <StepBadge n={2} />
                Completa los espacios
              </legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {values.map((value, i) => {
                  const n = i + 1;
                  const ctx = variableContext(selected.body, n);
                  const empty = !value.trim();
                  return (
                    <label
                      key={`${selected.id}-${n}`}
                      htmlFor={`${idPrefix}-variable-${n}`}
                      className="flex min-w-0 flex-col gap-1 text-[13px] text-text-2"
                    >
                      <span>
                        Espacio {n}
                        {ctx ? ` · va en “${ctx}”` : ""}
                      </span>
                      <Input
                        id={`${idPrefix}-variable-${n}`}
                        value={value}
                        aria-invalid={empty && missing === n ? true : undefined}
                        onChange={(e) => {
                          // Otro texto ya no es el mismo mensaje repetido.
                          setDuplicate(null);
                          setVariables(() => {
                            const next = [...values];
                            next[i] = e.target.value;
                            return next;
                          });
                        }}
                        placeholder={n === 1 ? "p. ej. el nombre del cliente" : "Escribe aquí"}
                        className={cn(
                          "text-foreground",
                          empty && missing === n && "border-warning focus-visible:ring-warning"
                        )}
                      />
                    </label>
                  );
                })}
              </div>
              {showPrefillNote && (
                <p className="text-[12.5px] text-text-2">
                  Ya pusimos el nombre de {prefilled} por ti. Revisa que esté bien.
                </p>
              )}
            </fieldset>
          )}
        </div>

        <div className="min-w-0 flex-1 basis-[280px] space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <StepBadge n={selected && variableCount > 0 ? 3 : 2} />
            Revisa y envía
          </p>
          <div className="space-y-2.5 rounded-lg bg-chat p-3.5">
            <p className="text-xs text-text-2">
              {selected
                ? `Así le va a llegar a ${name ?? "este cliente"}:`
                : "Elige un mensaje para ver cómo le va a llegar."}
            </p>
            {selected && (
              <p
                data-testid="template-preview"
                className="ml-auto max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-brand-soft bg-bubble-out px-3 py-2.5 text-sm leading-relaxed text-bubble-out-text"
              >
                {previewSegments(selected.body, values).map((s, k) =>
                  s.kind === "text" ? (
                    <span key={k}>{s.text}</span>
                  ) : s.kind === "value" ? (
                    <strong key={k} className="font-semibold">
                      {s.text}
                    </strong>
                  ) : (
                    <span
                      key={k}
                      className="rounded border border-dashed border-warning bg-warning-tint px-1.5 text-warning-text"
                    >
                      falta este espacio
                    </span>
                  )
                )}
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {duplicate ? (
            <DuplicateWarning
              message={duplicate}
              name={name}
              sending={sending}
              onForce={() => void send(true)}
              onCancel={() => setDuplicate(null)}
            />
          ) : (
            <Button
              className="w-full"
              onClick={() => void send()}
              disabled={sending || blockedReason !== null}
              aria-describedby={blockedReason ? blockedId : undefined}
            >
              {sending ? "Enviando…" : submitLabel}
            </Button>
          )}
          {blockedReason && !duplicate && (
            <p id={blockedId} className="text-[12.5px] text-warning-text">
              {blockedReason}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Sin plantillas aprobadas: qué sigue, según el rol. */
export function NoTemplatesNotice({
  title,
  intro,
  contactName,
  firstContact = false,
}: {
  title: string;
  /** Por qué hace falta una plantilla (va antes de «Aún no tienes…»). */
  intro: string;
  contactName: string;
  /** Contactos (escribir primero) en vez de la Bandeja (retomar un chat). */
  firstContact?: boolean;
}) {
  // Crear plantillas es un ajuste del Propietario (dev-tasks/00, RF-00-08).
  const owner = isOwner(useViewer());
  const name = displayFirstName(contactName);
  return (
    <section
      aria-labelledby="sin-plantillas-titulo"
      data-testid="no-templates"
      className="flex flex-wrap items-start gap-4"
    >
      <span
        aria-hidden
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-text-2"
      >
        <MessageSquareText className="h-5 w-5" strokeWidth={1.7} />
      </span>
      <div className="min-w-0 flex-1 basis-[300px] space-y-3">
        <div className="space-y-1">
          <h2 id="sin-plantillas-titulo" className="text-[15px] font-semibold">
            {title}
          </h2>
          <p className="max-w-[620px] text-[13.5px] text-text-2">
            {intro}{" "}
            {owner ? "Aún no tienes ninguno aprobado." : "Tu equipo aún no tiene ninguno."}
          </p>
        </div>
        <NextSteps
          items={[
            owner ? (
              <Link
                key="crear"
                href="/settings/templates"
                className="font-medium text-brand-text underline underline-offset-2 hover:text-brand"
              >
                Crear una plantilla en Ajustes → Plantillas
              </Link>
            ) : (
              firstContact
                ? "Avísale al propietario que necesitas una plantilla para escribirle primero a un cliente. Las crea él en Ajustes."
                : "Avísale al propietario que necesitas una plantilla para retomar chats. Las crea él en Ajustes."
            ),
            "WhatsApp la revisa; suele tardar desde unos minutos hasta un día.",
            "Cuando esté aprobada, aparecerá aquí mismo para que la mandes.",
          ]}
        />
        <ReopenNote>
          {firstContact ? (
            <>
              Si {name ?? "el cliente"} te escribe primero, ya no hace falta plantilla:
              podrás responderle normal desde la Bandeja.
            </>
          ) : (
            <>
              Si {name ?? "el cliente"} te vuelve a escribir, este espacio se convierte en
              la caja de texto y podrás responderle normal.
            </>
          )}
        </ReopenNote>
      </div>
    </section>
  );
}

/**
 * Ventana de 24 h cerrada en WhatsApp (FR-005/FR-051). 031: en tres pasos
 * (`TemplateSteps`); sin plantillas aprobadas, qué sigue según el rol.
 * 033: si la última del hilo es una plantilla que salió, la tarjeta
 * «Plantilla enviada» ocupa su lugar; si falló, los pasos con el aviso.
 */
export function TemplateSender({
  conversationId,
  contactName,
  lastTemplate = null,
  threadReady = true,
  onSent,
}: {
  conversationId: string;
  contactName: string;
  /**
   * 033 — ¿Ya llegó el hilo de esta conversación? Mientras no, ni tarjeta ni
   * pasos: el encabezado y «Cargando…» (los pasos un instante antes de la
   * tarjeta invitarían a reenviar).
   */
  threadReady?: boolean;
  /** 033: el último mensaje del hilo, si es una plantilla saliente. */
  lastTemplate?: LastTemplate | null;
  onSent: () => void;
}) {
  const name = displayFirstName(contactName);
  // «Enviar otra plantilla»: local a este chat (el Composer va con `key` por
  // conversación). Se cierra solo cuando llega una plantilla nueva.
  const [anotherFor, setAnotherFor] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const sentOk = lastTemplate !== null && lastTemplate.status !== "failed";
  const showCard = sentOk && anotherFor !== lastTemplate.id;
  const another = sentOk && !showCard;
  const lastText = sentOk ? lastTemplate.text : null;

  // Nombre de la plantilla para la tarjeta, reconocido por el texto. Si no
  // se reconoce, la tarjeta lo omite.
  useEffect(() => {
    if (!lastText) return;
    let cancelled = false;
    fetch("/api/templates")
      .then((r) => (r.ok ? (r.json() as Promise<{ templates?: TemplateDto[] }>) : null))
      .then((d) => {
        if (cancelled || !d?.templates) return;
        const hit = matchTemplateByText(lastText, d.templates);
        setLabel(hit ? (templateLabels(d.templates).get(hit.id) ?? null) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lastText]);

  const closedIntro = (
    <>
      Pasaron más de 24 horas desde su último mensaje, y WhatsApp solo deja retomar
      con una plantilla. Cuando {name ?? "el cliente"} te conteste, podrás escribir
      normal otra vez.
    </>
  );

  if (!threadReady) {
    return (
      <section aria-labelledby="retomar-titulo" className="space-y-3" aria-busy="true">
        <ClosedHeader
          id="retomar-titulo"
          title={`Para escribirle a ${name ?? "este cliente"}, usa un mensaje aprobado`}
        >
          {closedIntro}
        </ClosedHeader>
        <p role="status" data-testid="template-thread-loading" className="text-[13px] text-text-3">
          Cargando…
        </p>
      </section>
    );
  }

  if (showCard && lastTemplate) {
    return (
      <TemplateSentCard
        last={lastTemplate}
        name={name}
        templateLabel={label}
        onAnother={() => setAnotherFor(lastTemplate.id)}
      />
    );
  }

  const headerTitle = another
    ? `Enviar otra plantilla a ${name ?? "este cliente"}`
    : `Para escribirle a ${name ?? "este cliente"}, usa un mensaje aprobado`;

  async function send(
    templateId: string,
    variables: string[] | undefined,
    options?: TemplateSendOptions
  ): Promise<TemplateSendResult> {
    const res = await fetch(`/api/conversations/${conversationId}/messages/template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId, variables, ...(options?.force ? { force: true } : {}) }),
    }).catch(() => null);
    if (!res) return { ok: false, message: "Sin conexión con el servidor. Intenta de nuevo." };
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      return templateSendFailure(data, "No se pudo enviar la plantilla");
    }
    return { ok: true };
  }

  return (
    <TemplateSteps
      groupName={`template-${conversationId}`}
      contactName={contactName}
      headingId="retomar-titulo"
      testId="template-sender"
      submitLabel="Enviar plantilla"
      header={
        <ClosedHeader id="retomar-titulo" title={headerTitle}>
          {closedIntro}
        </ClosedHeader>
      }
      notice={
        lastTemplate?.status === "failed" ? (
          <LastSendFailedNotice last={lastTemplate} name={name} />
        ) : undefined
      }
      emptyState={
        <NoTemplatesNotice
          title="Todavía no puedes retomar este chat"
          intro={`Pasaron más de 24 horas y para escribirle a ${name ?? "este cliente"} hace falta un mensaje aprobado por WhatsApp (plantilla).`}
          contactName={contactName}
        />
      }
      send={send}
      // La tarjeta vuelve sola: la plantilla nueva (llega por el refetch)
      // trae otro id que `anotherFor`.
      onSent={() => onSent()}
    />
  );
}
