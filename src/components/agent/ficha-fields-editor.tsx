"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  FICHA_FIELD_TYPES,
  FICHA_FIELD_TYPE_LABEL,
  FICHA_LIMITS,
  FICHA_TEMPLATE_AUTOS_ELECTRICOS,
  type FichaFieldType,
} from "@/lib/ficha-fields";
import type { FichaFieldsResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  defToDraft,
  emptyDraft,
  moveDraft,
  parseServerFieldErrors,
  validateDrafts,
  withLabel,
  type FieldDraft,
  type FieldErrors,
} from "@/components/ficha-view";

const SIN_ERRORES: FieldErrors = { rows: {}, general: [] };

type Carga = "cargando" | "lista" | "error";

/**
 * Agente → "Campos de la ficha" (04, solo Propietario).
 *
 * Qué datos califican a un lead, con su tipo y una pista para el agente. Sin
 * campos definidos, la ficha es libre y el agente in-process no la llena.
 *
 * Carga por su cuenta y no en el `Promise.all` del perfil: si este endpoint
 * falla, el resto de la pantalla del Agente sigue funcionando.
 */
export function FichaFieldsEditor() {
  const [drafts, setDrafts] = useState<FieldDraft[]>([]);
  const [carga, setCarga] = useState<Carga>("cargando");
  const [errors, setErrors] = useState<FieldErrors>(SIN_ERRORES);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [sucio, setSucio] = useState(false);
  const [confirmarPlantilla, setConfirmarPlantilla] = useState(false);

  const cargar = useCallback(async () => {
    const res = await fetch("/api/agent/ficha-fields").catch(() => null);
    if (!res?.ok) {
      setCarga("error");
      return;
    }
    const body = (await res.json().catch(() => null)) as FichaFieldsResponse | null;
    setDrafts((body?.fields ?? []).map(defToDraft));
    setCarga("lista");
    setSucio(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function cambiar(next: FieldDraft[]) {
    setDrafts(next);
    setSucio(true);
    setGuardado(false);
    if (errors !== SIN_ERRORES) setErrors(SIN_ERRORES);
  }

  function actualizar(i: number, patch: (d: FieldDraft) => FieldDraft) {
    cambiar(drafts.map((d, j) => (j === i ? patch(d) : d)));
  }

  function usarPlantilla() {
    if (drafts.length > 0 && !confirmarPlantilla) {
      setConfirmarPlantilla(true);
      return;
    }
    setConfirmarPlantilla(false);
    // Copia profunda: la plantilla es una constante compartida.
    cambiar(
      FICHA_TEMPLATE_AUTOS_ELECTRICOS.map((f) =>
        defToDraft({ ...f, options: f.options ? [...f.options] : undefined })
      )
    );
  }

  async function guardar() {
    const v = validateDrafts(drafts);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setGuardando(true);
    setErrors(SIN_ERRORES);
    try {
      const res = await fetch("/api/agent/ficha-fields", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: v.fields }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as FichaFieldsResponse | null;
        setDrafts((body?.fields ?? v.fields).map(defToDraft));
        setSucio(false);
        setGuardado(true);
        setTimeout(() => setGuardado(false), 2000);
        return;
      }
      const err = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      const message = err?.error?.message ?? "";
      if (res.status === 422 && message) {
        setErrors(parseServerFieldErrors(message));
      } else if (res.status === 403) {
        setErrors({ rows: {}, general: ["Solo el Propietario puede cambiar los campos."] });
      } else {
        setErrors({
          rows: {},
          general: [message || "No se pudieron guardar los campos. Intenta de nuevo."],
        });
      }
    } catch {
      setErrors({
        rows: {},
        general: ["No se pudieron guardar los campos. Revisa tu conexión."],
      });
    } finally {
      setGuardando(false);
    }
  }

  const lleno = drafts.length >= FICHA_LIMITS.maxFields;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Campos de la ficha</CardTitle>
            <CardDescription>
              Qué datos califican a un lead. El agente los averigua en la
              conversación y los guarda; lo que corrija tu equipo, no lo vuelve
              a cambiar. Si no defines campos, el agente no llena la ficha.
            </CardDescription>
          </div>
          <Badge variant={lleno ? "warning" : "secondary"}>
            {drafts.length}/{FICHA_LIMITS.maxFields}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {carga === "cargando" && <p className="text-sm text-muted-foreground">Cargando…</p>}

        {carga === "error" && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning-soft bg-warning-tint p-3 text-sm text-warning-text">
            No se pudieron cargar los campos de la ficha.
            <Button size="sm" variant="outline" onClick={() => void cargar()}>
              Reintentar
            </Button>
          </div>
        )}

        {carga === "lista" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={usarPlantilla}>
                Usar plantilla: agencia de autos eléctricos
              </Button>
              {confirmarPlantilla && (
                <span className="flex flex-wrap items-center gap-2 text-xs text-warning-text">
                  Reemplaza los {drafts.length} campos actuales (sin guardar aún).
                  <Button size="sm" variant="secondary" onClick={usarPlantilla}>
                    Sí, reemplazar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmarPlantilla(false)}>
                    Cancelar
                  </Button>
                </span>
              )}
            </div>

            {drafts.length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                Sin campos: la ficha es libre y el agente no la llena.
              </p>
            )}

            <ol className="space-y-2">
              {drafts.map((d, i) => (
                <FieldRow
                  key={d.uid}
                  draft={d}
                  index={i}
                  total={drafts.length}
                  errors={errors.rows[i] ?? {}}
                  onChange={(patch) => actualizar(i, patch)}
                  onMove={(dir) => cambiar(moveDraft(drafts, i, dir))}
                  onRemove={() => cambiar(drafts.filter((_, j) => j !== i))}
                />
              ))}
            </ol>

            {errors.general.length > 0 && (
              <ul role="alert" className="space-y-0.5 text-xs text-danger-text">
                {errors.general.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={lleno}
                onClick={() => cambiar([...drafts, emptyDraft()])}
              >
                <Plus className="h-4 w-4" /> Agregar campo
              </Button>
              <Button size="sm" disabled={guardando || !sucio} onClick={() => void guardar()}>
                {guardando ? "Guardando…" : "Guardar campos"}
              </Button>
              {guardado && <span className="text-xs text-primary">Guardado ✓</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FieldRow({
  draft: d,
  index,
  total,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  draft: FieldDraft;
  index: number;
  total: number;
  errors: Record<string, string>;
  onChange: (patch: (d: FieldDraft) => FieldDraft) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const id = (campo: string) => `ff-${d.uid}-${campo}`;
  const nombre = d.label.trim() || `campo ${n}`;

  return (
    <li className="rounded-md border p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem_auto]">
        <div className="space-y-1">
          <label htmlFor={id("label")} className="text-xs text-muted-foreground">
            Etiqueta
          </label>
          <Input
            id={id("label")}
            value={d.label}
            maxLength={FICHA_LIMITS.maxLabelLen}
            placeholder="p. ej. Presupuesto"
            aria-invalid={errors.label ? true : undefined}
            onChange={(e) => onChange((x) => withLabel(x, e.target.value))}
          />
          {errors.label && <p className="text-[11px] text-danger-text">{errors.label}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor={id("key")} className="text-xs text-muted-foreground">
            Clave
          </label>
          <Input
            id={id("key")}
            value={d.key}
            maxLength={FICHA_LIMITS.maxKeyLen}
            placeholder="presupuesto"
            className="font-mono text-xs"
            aria-invalid={errors.key ? true : undefined}
            onChange={(e) => onChange((x) => ({ ...x, key: e.target.value, keyTouched: true }))}
          />
          {errors.key && <p className="text-[11px] text-danger-text">{errors.key}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor={id("type")} className="text-xs text-muted-foreground">
            Tipo
          </label>
          <select
            id={id("type")}
            value={d.type}
            onChange={(e) => onChange((x) => ({ ...x, type: e.target.value as FichaFieldType }))}
            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
          >
            {FICHA_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FICHA_FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={index === 0}
            aria-label={`Subir ${nombre}`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={index === total - 1}
            aria-label={`Bajar ${nombre}`}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Quitar ${nombre}`} onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {d.type === "opcion" && (
        <div className="mt-2 space-y-1">
          <label htmlFor={id("options")} className="text-xs text-muted-foreground">
            Opciones (separadas por coma, de {FICHA_LIMITS.minOptions} a{" "}
            {FICHA_LIMITS.maxOptions})
          </label>
          <Input
            id={id("options")}
            value={d.options}
            placeholder="contado, financiamiento, arrendamiento"
            aria-invalid={errors.options ? true : undefined}
            onChange={(e) => onChange((x) => ({ ...x, options: e.target.value }))}
          />
          {errors.options && <p className="text-[11px] text-danger-text">{errors.options}</p>}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={d.allowOther}
              onChange={(e) => onChange((x) => ({ ...x, allowOther: e.target.checked }))}
            />
            Permitir otro valor
          </label>
        </div>
      )}

      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <label htmlFor={id("hint")} className="text-xs text-muted-foreground">
            Pista para el agente (opcional)
          </label>
          <Input
            id={id("hint")}
            value={d.hint}
            maxLength={FICHA_LIMITS.maxHintLen}
            placeholder="p. ej. monto total que dice poder pagar; no el enganche"
            aria-invalid={errors.hint ? true : undefined}
            onChange={(e) => onChange((x) => ({ ...x, hint: e.target.value }))}
          />
          {errors.hint && <p className="text-[11px] text-danger-text">{errors.hint}</p>}
        </div>
        <div className="flex h-9 items-center gap-2">
          <span className="text-xs text-muted-foreground">El agente lo llena</span>
          <button
            role="switch"
            aria-checked={d.agentFills}
            aria-label={`El agente llena ${nombre}`}
            onClick={() => onChange((x) => ({ ...x, agentFills: !x.agentFills }))}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors",
              d.agentFills ? "bg-brand" : "bg-border-strong"
            )}
          >
            <span
              className={cn(
                "h-4 w-4 rounded-full bg-knob shadow-sm transition-transform",
                d.agentFills ? "translate-x-4" : "translate-x-0"
              )}
            />
          </button>
        </div>
      </div>

      {(errors._ || errors.type || errors.agentFills) && (
        <p className="mt-1 text-[11px] text-danger-text">
          {errors._ ?? errors.type ?? errors.agentFills}
        </p>
      )}
    </li>
  );
}
