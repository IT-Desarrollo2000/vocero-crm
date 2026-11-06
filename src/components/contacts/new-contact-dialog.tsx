"use client";

import { useCallback, useEffect, useState } from "react";
import type { SourceValue, StageDto } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const SOURCES: { value: SourceValue; label: string }[] = [
  { value: "referido", label: "Referido" },
  { value: "organico", label: "Contenido orgánico" },
  { value: "conocido", label: "Conocido" },
  { value: "anuncio", label: "Anuncio" },
  { value: "web", label: "Sitio web" },
  { value: "promotor", label: "Promotor" },
  { value: "otro", label: "Otro" },
];

/**
 * Alta manual de un prospecto que no llegó por WhatsApp.
 * El teléfono es obligatorio porque ES la identidad en WhatsApp: sin él, el
 * contacto no podría recibir ni mandar nada, y sería una ficha muerta.
 */
export function NewContactDialog({
  onClose,
  onCreated,
  onOpenExisting,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Duplicado: en vez de un error seco, se ofrece ir a quien ya existe. */
  onOpenExisting: (contactId: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState<SourceValue>("referido");
  const [notes, setNotes] = useState("");
  // null = cargando: con `[]` de inicio, «No hay etapas abiertas» parpadeaba
  // en cada apertura aunque sí las hubiera.
  const [stages, setStages] = useState<StageDto[] | null>(null);
  const [stagesFailed, setStagesFailed] = useState(false);
  const [stageId, setStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicado, setDuplicado] = useState<{ id: string; name: string } | null>(
    null
  );

  const loadStages = useCallback(async () => {
    setStagesFailed(false);
    const res = await fetch("/api/pipeline/stages").catch(() => null);
    const data = res?.ok
      ? ((await res.json().catch(() => null)) as { stages?: StageDto[] } | null)
      : null;
    if (!data?.stages) {
      setStagesFailed(true);
      return;
    }
    const abiertas = data.stages.filter((s) => s.kind === "open");
    setStages(abiertas);
    setStageId(abiertas[0]?.id ?? "");
  }, []);

  useEffect(() => {
    void loadStages();
  }, [loadStages]);

  async function guardar() {
    setSaving(true);
    setError(null);
    setDuplicado(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        phone: phone.trim(),
        source,
        notes: notes.trim() || undefined,
        stageId: stageId || undefined,
      }),
    }).catch(() => null);
    setSaving(false);

    if (!res) {
      setError("No se pudo guardar. Revisa tu conexión.");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      contact?: { id: string; name: string };
    } | null;

    if (res.status === 409 && data?.contact) {
      setDuplicado({ id: data.contact.id, name: data.contact.name });
      return;
    }
    if (!res.ok) {
      setError(data?.error?.message ?? "No se pudo guardar el contacto");
      return;
    }
    onCreated();
  }

  // 11 dígitos = código de país + número. Ver la nota del endpoint sobre por
  // qué el código de país no puede faltar ni asumirse.
  const digits = phone.replace(/\D/g, "").length;
  // 032: por qué no se puede crear todavía, en texto visible bajo el botón.
  const blockedReason = stagesFailed
    ? null // lo explica el aviso con «Reintentar»
    : stages === null
      ? "Cargando las etapas del embudo…"
      : stages.length === 0
        ? null // lo explica el aviso de «No hay etapas abiertas»
        : !name.trim()
          ? "Escribe su nombre para poder crearlo."
          : digits < 11
            ? "Escribe el teléfono completo, con código de país (52 para México), para poder crearlo."
            : null;
  const listo =
    !stagesFailed && stages !== null && stages.length > 0 && name.trim().length > 0 && digits >= 11;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Nuevo contacto"
        className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 font-semibold">Nuevo contacto</h3>
        <p className="mb-4 text-xs text-text-3">
          Para prospectos que no llegaron por WhatsApp: referidos, gente que te
          escribió por otra red, conocidos.
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="nc-name">
              Nombre
            </label>
            <Input
              id="nc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ferretería La Central"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="nc-phone">
              Teléfono con código de país
            </label>
            <Input
              id="nc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="52 462 134 9768"
            />
            <p className="text-[11px] text-text-3">
              Escríbelo con espacios si quieres, pero{" "}
              <strong>incluye el código de país</strong> (52 para México). Sin
              él, WhatsApp no lo reconoce como la misma persona que te escriba
              después.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nc-source">
                ¿De dónde salió?
              </label>
              <select
                id="nc-source"
                value={source}
                onChange={(e) => setSource(e.target.value as SourceValue)}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="nc-stage">
                Etapa inicial
              </label>
              <select
                id="nc-stage"
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                {(stages ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="nc-notes">
              Notas (opcional)
            </label>
            <Textarea
              id="nc-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Me lo pasó Juan; tiene taller de motos…"
            />
          </div>
        </div>

        {duplicado && (
          <div className="mt-3 rounded-md border border-warning-soft bg-warning-tint px-3 py-2.5">
            <p className="text-[13px] text-warning-text">
              Ese teléfono ya es de <strong>{duplicado.name}</strong>. No se creó
              un duplicado.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onOpenExisting(duplicado.id)}
            >
              Abrir su conversación
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger-text">
            {error}
          </p>
        )}
        {stagesFailed && (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-xs text-danger-text"
          >
            <p className="min-w-0 flex-1">
              No se pudieron cargar las etapas del embudo; sin ellas no se puede crear el contacto.
            </p>
            <Button size="sm" variant="outline" onClick={() => void loadStages()}>
              Reintentar
            </Button>
          </div>
        )}
        {stages !== null && stages.length === 0 && (
          <p className="mt-3 text-xs text-warning-text">
            No hay etapas abiertas. Crea una en Seguimiento antes de
            capturar contactos.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!listo || saving}
            aria-describedby={blockedReason ? "nc-blocked-reason" : undefined}
            onClick={() => void guardar()}
          >
            {saving ? "Guardando…" : "Crear contacto"}
          </Button>
        </div>
        {blockedReason && (
          <p id="nc-blocked-reason" className="mt-2 text-right text-[12.5px] text-text-2">
            {blockedReason}
          </p>
        )}
      </div>
    </div>
  );
}
