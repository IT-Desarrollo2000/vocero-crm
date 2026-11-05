"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Clock3, MessageSquareText, RotateCcw } from "lucide-react";
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
 * Ventana de 24 h cerrada en WhatsApp (FR-005/FR-051). 031: en tres pasos —
 * elige el mensaje, completa los espacios (con su contexto y el nombre ya
 * puesto si el cuerpo saluda), revisa la vista previa y envía. Sin plantillas
 * aprobadas, qué sigue según el rol.
 */
export function TemplateSender({
  conversationId,
  contactName,
  onSent,
}: {
  conversationId: string;
  contactName: string;
  onSent: () => void;
}) {
  // Crear plantillas es un ajuste del Propietario (dev-tasks/00, RF-00-08).
  const owner = isOwner(useViewer());
  const name = displayFirstName(contactName);
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [variables, setVariables] = useState<string[]>([]);
  // El nombre que pusimos solos en {{1}} (para el aviso «Ya pusimos…»).
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(
    (t: TemplateDto | null) => {
      setSelectedId(t?.id ?? "");
      setError(null);
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

  const headerTitle = `Para escribirle a ${name ?? "este cliente"}, usa un mensaje aprobado`;
  const header = (
    <ClosedHeader id="retomar-titulo" title={headerTitle}>
      Pasaron más de 24 horas desde su último mensaje, y WhatsApp solo deja
      retomar con una plantilla. Cuando {name ?? "el cliente"} te conteste, podrás
      escribir normal otra vez.
    </ClosedHeader>
  );

  if (loadFailed) {
    return (
      <section aria-labelledby="retomar-titulo" className="space-y-3">
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
      <section aria-labelledby="retomar-titulo" className="space-y-3" aria-busy="true">
        {header}
        <p role="status" className="text-[13px] text-text-3">
          Cargando plantillas…
        </p>
      </section>
    );
  }

  if (templates.length === 0) {
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
              Todavía no puedes retomar este chat
            </h2>
            <p className="max-w-[620px] text-[13.5px] text-text-2">
              Pasaron más de 24 horas y para escribirle a {name ?? "este cliente"} hace
              falta un mensaje aprobado por WhatsApp (plantilla).{" "}
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
                "Avísale al propietario que necesitas una plantilla para retomar chats. Las crea él en Ajustes."
              ),
              "WhatsApp la revisa; suele tardar desde unos minutos hasta un día.",
              "Cuando esté aprobada, aparecerá aquí mismo para que la mandes.",
            ]}
          />
          <ReopenNote>
            Si {name ?? "el cliente"} te vuelve a escribir, este espacio se convierte en
            la caja de texto y podrás responderle normal.
          </ReopenNote>
        </div>
      </section>
    );
  }

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

  async function send() {
    if (!selected || sending || blockedReason) return;
    setSending(true);
    setError(null);
    const res = await fetch(`/api/conversations/${conversationId}/messages/template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateId: selected.id,
        variables: variableCount > 0 ? values : undefined,
      }),
    }).catch(() => null);
    setSending(false);
    if (!res) {
      setError("Sin conexión con el servidor. Intenta de nuevo.");
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo enviar la plantilla");
      return;
    }
    choose(templates && templates.length === 1 ? (templates[0] ?? null) : null);
    onSent();
  }

  return (
    <section aria-labelledby="retomar-titulo" data-testid="template-sender" className="space-y-4">
      {header}

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
                    name={`template-${conversationId}`}
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
                      htmlFor={`template-variable-${n}`}
                      className="flex min-w-0 flex-col gap-1 text-[13px] text-text-2"
                    >
                      <span>
                        Espacio {n}
                        {ctx ? ` · va en “${ctx}”` : ""}
                      </span>
                      <Input
                        id={`template-variable-${n}`}
                        value={value}
                        aria-invalid={empty && missing === n ? true : undefined}
                        onChange={(e) =>
                          setVariables(() => {
                            const next = [...values];
                            next[i] = e.target.value;
                            return next;
                          })
                        }
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
          <Button
            className="w-full"
            onClick={() => void send()}
            disabled={sending || blockedReason !== null}
            aria-describedby={blockedReason ? "template-blocked-reason" : undefined}
          >
            {sending ? "Enviando…" : "Enviar plantilla"}
          </Button>
          {blockedReason && (
            <p id="template-blocked-reason" className="text-[12.5px] text-warning-text">
              {blockedReason}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
