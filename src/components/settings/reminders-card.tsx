"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  REMINDER_FIELDS,
  REMINDER_FIELD_LABEL,
  REMINDER_MAX_OFFSETS,
  type ReminderSettingsDto,
} from "@/lib/reminders";
import { renderBody } from "@/lib/templates";
import type { TemplateDto } from "@/lib/types";
import {
  REMINDERS_SOON_MESSAGE,
  REMINDER_OFFSET_HOURS_LIMITS,
  SECOND_OFFSET_SUGGESTION_HOURS,
  approvedTemplates,
  buildReminderInput,
  classifyReminderSave,
  formFromDto,
  reminderWarningMessage,
  resizeMapping,
  templateVariableCount,
  type MappingSlot,
  type ReminderForm,
} from "./reminder-settings-logic";

/**
 * 10 — Ajustes → Agenda → Recordatorios (solo Propietario: la página vive en
 * `settings/(owner)`). Un aviso por WhatsApp con plantilla APROBADA, 1 o 2
 * anticipaciones, y qué va en cada `{{n}}`.
 *
 * Se guarda con su propio botón y manda SOLO los campos de recordatorio: si
 * el servidor todavía no los acepta (501), el horario de la agenda se sigue
 * guardando igual con el botón de arriba.
 */
export function RemindersCard({ initial }: { initial: ReminderSettingsDto }) {
  const [saved, setSaved] = useState<ReminderSettingsDto>(initial);
  const [form, setForm] = useState<ReminderForm>(() => formFromDto(initial));
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const enableNoticeId = useId();

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/templates").catch(() => null);
      if (!res?.ok) return setTemplates([]);
      const data = (await res.json().catch(() => null)) as {
        templates?: TemplateDto[];
      } | null;
      setTemplates(data?.templates ?? []);
    })();
  }, []);

  const approved = useMemo(() => approvedTemplates(templates ?? []), [templates]);
  const selected = useMemo(
    () => (templates ?? []).find((t) => t.id === form.templateId) ?? null,
    [templates, form.templateId]
  );
  const variableCount = selected
    ? templateVariableCount(selected)
    : (saved.template?.variableCount ?? 0);

  // Las variables siguen a la plantilla: una caja por {{n}}.
  useEffect(() => {
    if (!selected) return;
    setForm((f) =>
      f.variables.length === variableCount
        ? f
        : { ...f, variables: resizeMapping(f.variables, variableCount) }
    );
  }, [selected, variableCount]);

  function patch(next: Partial<ReminderForm>) {
    setForm((f) => ({ ...f, ...next }));
    setOk(false);
    setNotice(null);
  }

  function setOffset(index: number, value: string) {
    const offsetsHours = [...form.offsetsHours];
    offsetsHours[index] = value === "" ? Number.NaN : Number(value);
    patch({ offsetsHours });
  }

  function setVariable(index: number, value: MappingSlot) {
    const variables = resizeMapping(form.variables, Math.max(variableCount, index + 1));
    variables[index] = value;
    patch({ variables });
  }

  async function save() {
    setError(null);
    setNotice(null);
    setOk(false);
    const check = buildReminderInput(form, selected);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setSaving(true);
    const res = await fetch("/api/calendar/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(check.input),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      setError("No se pudieron guardar los recordatorios.");
      return;
    }
    const body: unknown = await res.json().catch(() => null);
    const outcome = classifyReminderSave(res.status, body);
    if (outcome.kind === "soon") {
      setNotice(REMINDERS_SOON_MESSAGE);
      return;
    }
    if (outcome.kind === "error") {
      setError(outcome.message);
      return;
    }
    setSaved(outcome.reminders);
    setForm(formFromDto(outcome.reminders));
    setOk(true);
  }

  const warning = reminderWarningMessage(saved.warning);
  // Al encender: no hay ráfaga sobre lo ya agendado (`reminder_enabled_at`).
  const turningOn = form.enabled && !saved.enabled;
  const selectedNotApproved = !!form.templateId && selected?.status !== "approved";
  const preview =
    selected && variableCount > 0
      ? renderBody(
          selected.body,
          resizeMapping(form.variables, variableCount).map((v, i) =>
            v ? `[${REMINDER_FIELD_LABEL[v]}]` : `{{${i + 1}}}`
          )
        )
      : (selected?.body ?? null);

  return (
    <section aria-label="Recordatorios">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Recordatorios</CardTitle>
              <CardDescription>
                Un aviso por WhatsApp antes de cada cita, con una plantilla
                aprobada por Meta. Si el envío falla, la cita sigue igual y se
                puede reintentar desde Citas.
              </CardDescription>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              aria-label="Activar recordatorios"
              aria-describedby={turningOn ? enableNoticeId : undefined}
              onClick={() => patch({ enabled: !form.enabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                form.enabled ? "bg-brand" : "bg-border-strong"
              }`}
            >
              <span
                className={`h-5 w-5 rounded-full bg-knob shadow-sm transition-transform ${
                  form.enabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {turningOn && (
            <p
              id={enableNoticeId}
              role="note"
              className="rounded-sm bg-brand-tint px-3 py-2 text-sm text-brand-text"
            >
              Solo se avisarán las citas cuyo recordatorio venza desde ahora.
            </p>
          )}

          {warning && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {warning}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="reminder-template">Plantilla</Label>
            {templates === null ? (
              <p className="text-sm text-text-3">Cargando plantillas…</p>
            ) : (
              <select
                id="reminder-template"
                aria-label="Plantilla del recordatorio"
                value={form.templateId ?? ""}
                onChange={(e) => patch({ templateId: e.target.value || null })}
                className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="">Elige una plantilla aprobada…</option>
                {approved.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language} · {t.category})
                  </option>
                ))}
                {/* La guardada que dejó de estar aprobada: visible, no elegible. */}
                {form.templateId && !approved.some((t) => t.id === form.templateId) && (
                  <option value={form.templateId} disabled>
                    {selected?.name ?? saved.template?.name ?? "Plantilla anterior"} (no
                    aprobada)
                  </option>
                )}
              </select>
            )}
            {templates !== null && approved.length === 0 && (
              <p className="text-sm text-text-3">
                No tienes plantillas aprobadas.{" "}
                <Link href="/settings/templates" className="text-brand-text hover:underline">
                  Crea una en Ajustes → Plantillas
                </Link>{" "}
                y espera a que Meta la apruebe.
              </p>
            )}
            {selectedNotApproved && templates !== null && (
              <p className="text-sm text-warning-text">
                La plantilla elegida no está aprobada: elige otra para activar
                los recordatorios.
              </p>
            )}
            {selected?.category === "MARKETING" && (
              <p className="text-sm text-warning-text">
                Meta clasificó esta plantilla como MARKETING: cada envío cuesta
                más que una de utilidad.
              </p>
            )}
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">
              Anticipación (horas antes de la cita)
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              {form.offsetsHours.map((h, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={REMINDER_OFFSET_HOURS_LIMITS.min}
                    max={REMINDER_OFFSET_HOURS_LIMITS.max}
                    step={1}
                    value={Number.isFinite(h) ? h : ""}
                    onChange={(e) => setOffset(i, e.target.value)}
                    aria-label={`Anticipación ${i + 1} en horas`}
                    className="w-24"
                  />
                  <span className="text-sm text-text-3">h</span>
                  {form.offsetsHours.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        patch({ offsetsHours: form.offsetsHours.filter((_, j) => j !== i) })
                      }
                      className="text-sm text-text-3 hover:text-foreground"
                      aria-label={`Quitar anticipación ${i + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {form.offsetsHours.length < REMINDER_MAX_OFFSETS && (
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      offsetsHours: [...form.offsetsHours, SECOND_OFFSET_SUGGESTION_HOURS],
                    })
                  }
                  className="text-xs text-brand-text hover:underline"
                >
                  + otro aviso
                </button>
              )}
            </div>
            <p className="text-xs text-text-3">
              De {REMINDER_OFFSET_HOURS_LIMITS.min} a {REMINDER_OFFSET_HOURS_LIMITS.max} horas;
              hasta {REMINDER_MAX_OFFSETS} avisos por cita.
            </p>
          </fieldset>

          {selected && variableCount > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Qué va en cada variable</legend>
              {Array.from({ length: variableCount }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Label htmlFor={`reminder-var-${i + 1}`} className="w-12 shrink-0 font-mono">
                    {`{{${i + 1}}}`}
                  </Label>
                  <select
                    id={`reminder-var-${i + 1}`}
                    aria-label={`Campo de la variable ${i + 1}`}
                    value={form.variables[i] ?? ""}
                    onChange={(e) => setVariable(i, e.target.value as MappingSlot)}
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                  >
                    <option value="">Elige un campo…</option>
                    {REMINDER_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {REMINDER_FIELD_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </fieldset>
          )}

          {preview && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-text-3">Vista previa</p>
              <p className="whitespace-pre-wrap rounded-sm bg-subtle px-3 py-2 text-sm text-text-2">
                {preview}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? "Guardando…" : "Guardar recordatorios"}
            </Button>
            {ok && <span className="text-sm text-brand-text">Guardado</span>}
            {notice && (
              <span role="status" className="text-sm text-text-3">
                {notice}
              </span>
            )}
            {error && (
              <span role="alert" className="text-sm text-destructive">
                {error}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
