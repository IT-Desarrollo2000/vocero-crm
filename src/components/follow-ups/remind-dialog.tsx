"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { firstName } from "@/lib/quick-replies";
import { useViewer } from "@/components/viewer-context";
import { dayIsoInTz } from "@/lib/time/slots";
import {
  DEFAULT_FOLLOW_UP_TIME,
  FOLLOW_UP_NOTE_MAX,
  FOLLOW_UP_REASONS,
  FOLLOW_UP_REASON_LABEL,
  REPEAT_MONTHS,
  WHEN_SHORTCUTS,
  WHEN_SHORTCUT_LABEL,
  shortcutDay,
  wallPreview,
  whenShort,
  type FollowUpDto,
  type FollowUpListDto,
  type FollowUpReason,
  type RepeatMonths,
  type WhenShortcut,
} from "@/lib/follow-ups";
import { apiErrorText, notifyFollowUpsChanged } from "./follow-up-events";

export const PILL_CLS =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const PILL_ON = "border-brand bg-brand-tint font-semibold text-brand-text";
export const PILL_OFF = "border-border bg-background text-foreground hover:bg-accent";

const FIELD_CLS =
  "rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 035 — «Recordarme de {cliente}»: cuándo (atajos + día y hora del negocio),
 * motivo, repetir y nota. Abajo, los recordatorios abiertos que YA tienes de
 * ese cliente, para no duplicar. Se usa desde el chat, el cajón del trato y
 * la fila de Contactos.
 */
export function RemindDialog({
  contact,
  conversationId = null,
  onClose,
  onSaved,
}: {
  contact: { id: string; name: string };
  conversationId?: string | null;
  onClose: () => void;
  onSaved?: (fu: FollowUpDto) => void;
}) {
  const me = useViewer();
  const titleId = useId();
  const [tz, setTz] = useState<string | null>(null);
  const [existing, setExisting] = useState<FollowUpDto[] | null>(null);
  const [shortcut, setShortcut] = useState<WhenShortcut | null>("tomorrow");
  const [day, setDay] = useState("");
  const [time, setTime] = useState(DEFAULT_FOLLOW_UP_TIME);
  const [reason, setReason] = useState<FollowUpReason>("volver_a_contactar");
  const [repeat, setRepeat] = useState<RepeatMonths | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Los abiertos de ESTE cliente que son de quien mira (también el
  // Propietario: «Ya tienes…» habla de los suyos), y la zona del negocio.
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ contactId: contact.id, userId: me.userId });
    fetch(`/api/follow-ups?${qs}`)
      .then((r) => (r.ok ? (r.json() as Promise<FollowUpListDto>) : null))
      .catch(() => null)
      .then((d) => {
        if (cancelled) return;
        const zone = d?.businessTimezone ?? "America/Mexico_City";
        setTz(zone);
        setExisting(d?.followUps ?? []);
        setDay((cur) => cur || shortcutDay("tomorrow", new Date(), zone));
      });
    return () => {
      cancelled = true;
    };
  }, [contact.id, me.userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const preview = tz && day && time ? wallPreview(day, time, tz) : null;
  const today = useMemo(() => (tz ? dayIsoInTz(new Date(), tz) : ""), [tz]);
  const blocked = !preview
    ? "Elige el día y la hora."
    : note.length > FOLLOW_UP_NOTE_MAX
      ? `La nota pasa de ${FOLLOW_UP_NOTE_MAX} caracteres.`
      : null;

  function pick(s: WhenShortcut) {
    if (!tz) return;
    setShortcut(s);
    setDay(shortcutDay(s, new Date(), tz));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/follow-ups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contactId: contact.id,
        conversationId,
        day,
        time,
        reason,
        note,
        repeatMonths: repeat,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiErrorText(res, "No se pudo guardar el recordatorio"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { followUp?: FollowUpDto } | null;
    notifyFollowUpsChanged();
    if (data?.followUp) onSaved?.(data.followUp);
    onClose();
  }

  const who = firstName(contact.name) || contact.name;
  const now = new Date();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-overlay p-3 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="remind-dialog"
        className="flex w-full max-w-[560px] flex-col rounded-lg border bg-background shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1 space-y-0.5">
            <h2 id={titleId} className="text-[17px] font-semibold">
              Recordarme de {contact.name}
            </h2>
            <p className="text-[13px] text-text-2">
              Solo lo ves tú. Te avisamos el día y la hora que elijas.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-5 px-5 py-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-semibold">¿Cuándo?</legend>
            <div className="flex flex-wrap gap-1.5">
              {WHEN_SHORTCUTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={shortcut === s}
                  // Sin la zona del negocio todavía no se sabe qué día es «mañana».
                  disabled={!tz}
                  onClick={() => pick(s)}
                  className={cn(PILL_CLS, shortcut === s ? PILL_ON : PILL_OFF)}
                >
                  {WHEN_SHORTCUT_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex min-w-[150px] flex-[1_1_150px] flex-col gap-1 text-[12.5px] text-text-2">
                Día
                <input
                  type="date"
                  value={day}
                  min={today || undefined}
                  onChange={(e) => {
                    setDay(e.target.value);
                    setShortcut(null);
                  }}
                  className={FIELD_CLS}
                />
              </label>
              <label className="flex min-w-[120px] flex-[1_1_120px] flex-col gap-1 text-[12.5px] text-text-2">
                Hora
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={FIELD_CLS}
                />
              </label>
            </div>
            <p className="text-[12.5px] text-text-2" data-testid="remind-preview">
              {preview ?? "Elige el día y la hora."}
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-semibold">Motivo</legend>
            <div className="flex flex-wrap gap-1.5">
              {FOLLOW_UP_REASONS.map((r) => (
                <label
                  key={r}
                  className={cn(PILL_CLS, "cursor-pointer", reason === r ? PILL_ON : PILL_OFF)}
                >
                  <input
                    type="radio"
                    name="follow-up-reason"
                    value={r}
                    checked={reason === r}
                    onChange={() => setReason(r)}
                    className="accent-[var(--accent)]"
                  />
                  {FOLLOW_UP_REASON_LABEL[r]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
            <label className="flex flex-col gap-1 text-sm font-semibold">
              Repetir
              <select
                value={repeat ?? ""}
                onChange={(e) => setRepeat(e.target.value ? (Number(e.target.value) as RepeatMonths) : null)}
                className={cn(FIELD_CLS, "font-normal")}
              >
                <option value="">No se repite</option>
                {REPEAT_MONTHS.map((m) => (
                  <option key={m} value={m}>
                    Cada {m} meses
                  </option>
                ))}
              </select>
            </label>
            <p className="flex-[1_1_200px] pb-2 text-[12.5px] text-text-2">
              Para servicios: al marcarlo como hecho, el siguiente se agenda solo.
            </p>
          </div>

          <label className="flex flex-col gap-1 text-sm font-semibold">
            <span>
              Nota <span className="font-normal text-text-2">(opcional: qué le vas a decir o qué pidió)</span>
            </span>
            <textarea
              rows={2}
              value={note}
              maxLength={FOLLOW_UP_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              className={cn(FIELD_CLS, "resize-y font-normal")}
            />
          </label>

          {error && (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-md border px-4 text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={blocked !== null || saving}
              className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "Guardando…" : "Guardar recordatorio"}
            </button>
          </div>
          {blocked && preview !== null && (
            <p className="-mt-3 text-right text-[12.5px] text-text-2">{blocked}</p>
          )}
        </form>

        {existing && existing.length > 0 && tz && (
          <footer className="flex flex-col gap-1.5 border-t px-5 py-3" data-testid="remind-existing">
            <p className="text-[12.5px] font-semibold text-text-2">
              Ya tienes {existing.length} {existing.length === 1 ? "recordatorio" : "recordatorios"} de {who}
            </p>
            {existing.map((fu) => (
              <p key={fu.id} className="flex flex-wrap items-center gap-x-2 text-[13px] text-text-2">
                <span>
                  {whenShort(fu.dueAt, now, tz)} · {FOLLOW_UP_REASON_LABEL[fu.reason]}
                </span>
                <Link
                  href="/pipeline?vista=pendientes"
                  onClick={onClose}
                  className="font-medium text-brand-text underline-offset-2 hover:underline"
                >
                  Ver en Pendientes
                </Link>
              </p>
            ))}
          </footer>
        )}
      </section>
    </div>
  );
}
