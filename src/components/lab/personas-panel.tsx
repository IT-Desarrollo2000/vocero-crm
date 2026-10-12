"use client";

import { useState } from "react";
import { AlertTriangle, Archive, Pencil, Plus, RotateCcw, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  LAB_MAX_PERSONAS_PER_RUN,
  LAB_MAX_SCRIPT_MESSAGES,
  LAB_SCRIPT_MESSAGE_MAX,
  LAB_SEED_SETS,
  type LabPersonaDto,
  type LabRestoreDefaultsResponse,
  type LabSeedSet,
} from "@/lib/lab";
import { labFetch } from "./lab-fetch";
import {
  EXPECT_FICHA_MAX_RULES,
  SEED_SET_LABELS,
  emptyPersonaDraft,
  estimateRunMinutes,
  personaToDraft,
  splitPersonas,
  validateExpectRule,
  validatePersonaDraft,
  type PersonaDraft,
  type PersonaDraftErrors,
} from "./lab-logic";

export type PersonasState =
  | { status: "loading" }
  /** `GET /api/lab/personas` aún responde 501. */
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; personas: LabPersonaDto[]; runInProgress: boolean };

/**
 * 08 — Personas del Laboratorio (solo Propietario): lista activas/archivadas,
 * crear/editar, archivar en dos pasos, restaurar las predeterminadas y elegir
 * cuáles entran a la próxima corrida (máx. 10).
 */
export function PersonasPanel({
  state,
  selected,
  selectionNotice,
  onToggle,
  onReload,
  onReplace,
}: {
  state: PersonasState;
  selected: string[];
  selectionNotice: string | null;
  onToggle: (key: string) => void;
  onReload: () => Promise<void>;
  onReplace: (personas: LabPersonaDto[]) => void;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const ready = state.status === "ready";
  const { live, archived } = ready ? splitPersonas(state.personas) : { live: [], archived: [] };
  const chosen = live.filter((p) => selected.includes(p.key));
  const activeCount = live.filter((p) => p.active).length;
  const nextPosition = live.reduce((max, p) => Math.max(max, p.position + 1), 0);

  return (
    <section aria-label="Personas" className="mx-4 mt-4 sm:mx-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-primary" /> Personas
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Clientes simulados con su guion. Sandbox: estas conversaciones nunca se
                envían por WhatsApp.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-label="Restaurar predeterminadas"
                disabled={!ready}
                onClick={() => {
                  setNotice(null);
                  setRestoring((v) => !v);
                }}
              >
                <RotateCcw className="h-4 w-4" /> Restaurar predeterminadas
              </Button>
              <Button
                size="sm"
                aria-label="Nueva persona"
                disabled={!ready}
                onClick={() => {
                  setNotice(null);
                  setEditing("new");
                }}
              >
                <Plus className="h-4 w-4" /> Nueva persona
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.status === "loading" && (
            <p className="text-sm text-muted-foreground">Cargando personas…</p>
          )}
          {state.status === "unavailable" && (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Disponible pronto: editar las personas desde aquí. Mientras tanto, cada
              evaluación corre con las personas predeterminadas.
            </p>
          )}
          {state.status === "error" && (
            <p className="text-sm text-danger-text" role="alert">
              {state.message}
            </p>
          )}

          {ready && state.runInProgress && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-2.5 text-xs text-warning-text"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Hay una evaluación en curso: los cambios que hagas aquí aplican a la
              siguiente corrida, no a la actual.
            </p>
          )}

          {restoring && ready && (
            <RestoreDefaults
              personas={state.personas}
              onCancel={() => setRestoring(false)}
              onDone={(res) => {
                onReplace(res.personas);
                setRestoring(false);
                setNotice(
                  res.restored.length > 0
                    ? `Restauradas ${res.restored.length} persona(s) del set "${SEED_SET_LABELS[res.set]}".`
                    : "Las predeterminadas ya estaban completas."
                );
              }}
            />
          )}
          {notice && (
            <p className="text-xs text-success-text" role="status">
              {notice}
            </p>
          )}

          {editing === "new" && (
            <PersonaForm
              initial={emptyPersonaDraft(nextPosition)}
              personaId={null}
              onCancel={() => setEditing(null)}
              onSaved={async (p) => {
                setEditing(null);
                setNotice(`Persona "${p.name}" creada.`);
                await onReload();
              }}
            />
          )}

          {ready && (
            <>
              <p className="text-xs text-muted-foreground">
                {chosen.length} de {activeCount} activa(s) en la próxima corrida (máx.{" "}
                {LAB_MAX_PERSONAS_PER_RUN})
                {chosen.length > 0 && ` · ≈ ${estimateRunMinutes(chosen)} min`}
              </p>
              {selectionNotice && (
                <p className="text-xs text-warning-text" role="status">
                  {selectionNotice}
                </p>
              )}
              {live.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No hay personas. Crea una o restaura las predeterminadas.
                </p>
              )}
              <ul className="space-y-2">
                {live.map((p) =>
                  editing === p.id ? (
                    <li key={p.id}>
                      <PersonaForm
                        initial={personaToDraft(p)}
                        personaId={p.id}
                        onCancel={() => setEditing(null)}
                        onSaved={async (saved) => {
                          setEditing(null);
                          setNotice(`Persona "${saved.name}" guardada.`);
                          await onReload();
                        }}
                      />
                    </li>
                  ) : (
                    <PersonaRow
                      key={p.id}
                      persona={p}
                      checked={selected.includes(p.key)}
                      onToggle={() => onToggle(p.key)}
                      onEdit={() => {
                        setNotice(null);
                        setEditing(p.id);
                      }}
                      onArchived={async () => {
                        setNotice(`Persona "${p.name}" archivada.`);
                        await onReload();
                      }}
                    />
                  )
                )}
              </ul>

              {archived.length > 0 && (
                <div className="border-t pt-3">
                  <button
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    aria-expanded={showArchived}
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived ? "Ocultar" : "Ver"} archivadas ({archived.length})
                  </button>
                  {showArchived && (
                    <ul className="mt-2 space-y-1" aria-label="Personas archivadas">
                      {archived.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
                        >
                          <Archive className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {p.seedSet && (
                            <span className="text-[11px]">
                              vuelve con «Restaurar predeterminadas»
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function PersonaRow({
  persona: p,
  checked,
  onToggle,
  onEdit,
  onArchived,
}: {
  persona: LabPersonaDto;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onArchived: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setBusy(true);
    setError(null);
    const res = await labFetch<{ persona: LabPersonaDto }>(
      `/api/lab/personas/${encodeURIComponent(p.id)}`,
      { method: "DELETE" },
      "No se pudo archivar la persona"
    );
    setBusy(false);
    if (!res.ok && res.outcome.kind !== "not_found") {
      setError(res.outcome.message);
      return;
    }
    setConfirming(false);
    await onArchived();
  }

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-start gap-3 p-3">
        <input
          type="checkbox"
          className="mt-1"
          aria-label={`Incluir ${p.name}`}
          checked={checked}
          disabled={!p.active}
          title={p.active ? undefined : "Inactiva: actívala para poder correrla"}
          onChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {p.name}
            {!p.active && <Badge variant="secondary">Inactiva</Badge>}
            {p.seedSet ? (
              <Badge variant="outline">Predeterminada</Badge>
            ) : (
              <Badge variant="outline">Personalizada</Badge>
            )}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {p.objetivo || p.guion[0] || "Sin objetivo"}
          </p>
          <p className="mt-0.5 text-[11px] text-text-3">
            {p.guion.length} mensaje(s)
            {p.expectFicha.length > 0 && ` · ${p.expectFicha.length} regla(s) de ficha`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            aria-label={`Editar ${p.name}`}
            title="Editar"
            onClick={onEdit}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          {!confirming && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              aria-label={`Archivar ${p.name}`}
              title="Archivar"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <span className="text-xs text-danger-text">
            ¿Archivar? Las corridas pasadas la conservan.
          </span>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void archive()}>
            {busy ? "Archivando…" : "Sí, archivar"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancelar
          </Button>
        </div>
      )}
      {error && (
        <p className="px-3 pb-2 text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function RestoreDefaults({
  personas,
  onCancel,
  onDone,
}: {
  personas: LabPersonaDto[];
  onCancel: () => void;
  onDone: (res: LabRestoreDefaultsResponse) => void;
}) {
  const current = personas.find((p) => p.seedSet)?.seedSet ?? "neutro";
  const [set, setSet] = useState<LabSeedSet>(current);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    const res = await labFetch<LabRestoreDefaultsResponse>(
      "/api/lab/personas/restore-defaults",
      { method: "POST", body: { set } },
      "No se pudieron restaurar las personas"
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.outcome.message);
      setConfirming(false);
      return;
    }
    onDone(res.data);
  }

  return (
    <div className="space-y-2 rounded-md border bg-secondary p-3">
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium">Set de personas predeterminadas</legend>
        {LAB_SEED_SETS.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="lab-seed-set"
              value={s}
              checked={set === s}
              onChange={() => {
                setSet(s);
                setConfirming(false);
              }}
            />
            {SEED_SET_LABELS[s]}
            {s === current && personas.some((p) => p.seedSet) && (
              <span className="text-[11px] text-muted-foreground">(el actual)</span>
            )}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Vuelve a agregar las predeterminadas que falten o estén archivadas
        {set !== current ? " y reescribe las predeterminadas con el set elegido" : ""}. Tus
        personas personalizadas no se tocan.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Restaurar
          </Button>
        ) : (
          <>
            <span className="text-xs text-warning-text">¿Seguro?</span>
            <Button size="sm" disabled={busy} onClick={() => void restore()}>
              {busy ? "Restaurando…" : "Sí, restaurar"}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      {error && (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-[11px] text-danger-text">
      {message}
    </p>
  );
}

function PersonaForm({
  initial,
  personaId,
  onCancel,
  onSaved,
}: {
  initial: PersonaDraft;
  personaId: string | null;
  onCancel: () => void;
  onSaved: (p: LabPersonaDto) => Promise<void>;
}) {
  const [d, setD] = useState<PersonaDraft>(initial);
  const [errors, setErrors] = useState<PersonaDraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = `persona-${personaId ?? "new"}`;
  const id = (k: string) => `${prefix}-${k}`;

  function set<K extends keyof PersonaDraft>(key: K, value: PersonaDraft[K]) {
    setD((x) => ({ ...x, [key]: value }));
  }

  async function save() {
    setError(null);
    const r = validatePersonaDraft(d);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const res = await labFetch<{ persona: LabPersonaDto }>(
      personaId ? `/api/lab/personas/${encodeURIComponent(personaId)}` : "/api/lab/personas",
      { method: personaId ? "PATCH" : "POST", body: r.input },
      "No se pudo guardar la persona"
    );
    setSaving(false);
    if (!res.ok) {
      setError(res.outcome.message);
      return;
    }
    await onSaved(res.data.persona);
  }

  const err = (k: string) => errors[k];

  return (
    <form
      aria-label={personaId ? `Editar persona ${initial.name}` : "Nueva persona"}
      className="space-y-3 rounded-md border border-brand bg-brand-tint p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={id("name")}>Nombre</Label>
          <Input
            id={id("name")}
            value={d.name}
            aria-invalid={err("name") ? true : undefined}
            onChange={(e) => set("name", e.target.value)}
          />
          <FieldError id={id("name-err")} message={err("name")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("contact")}>Nombre del contacto (opcional)</Label>
          <Input
            id={id("contact")}
            value={d.contactName}
            placeholder={d.name ? `[Prueba] ${d.name}` : "[Prueba] …"}
            onChange={(e) => set("contactName", e.target.value)}
          />
          <FieldError id={id("contact-err")} message={err("contactName")} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={id("objetivo")}>Objetivo</Label>
        <Textarea
          id={id("objetivo")}
          rows={2}
          value={d.objetivo}
          placeholder="Qué busca este cliente y qué debería lograr el agente"
          onChange={(e) => set("objetivo", e.target.value)}
        />
        <FieldError id={id("objetivo-err")} message={err("objetivo")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("rasgos")}>Rasgos (opcional)</Label>
        <Textarea
          id={id("rasgos")}
          rows={2}
          value={d.rasgos}
          placeholder="Impaciente, escribe con faltas, usa modismos…"
          onChange={(e) => set("rasgos", e.target.value)}
        />
        <FieldError id={id("rasgos-err")} message={err("rasgos")} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Guion ({d.guion.length}/{LAB_MAX_SCRIPT_MESSAGES})
        </legend>
        {d.guion.map((m, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor={id(`guion-${i}`)} className="text-xs">
                {i === 0 ? "Mensaje inicial" : `Mensaje ${i + 1}`}
              </Label>
              <span className="text-[11px] text-text-3">
                {m.trim().length}/{LAB_SCRIPT_MESSAGE_MAX}
              </span>
            </div>
            <div className="flex gap-2">
              <Textarea
                id={id(`guion-${i}`)}
                rows={2}
                value={m}
                aria-invalid={err(`guion.${i}`) ? true : undefined}
                onChange={(e) =>
                  set(
                    "guion",
                    d.guion.map((x, j) => (j === i ? e.target.value : x))
                  )
                }
              />
              {d.guion.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  aria-label={`Quitar mensaje ${i + 1}`}
                  onClick={() => set("guion", d.guion.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <FieldError id={id(`guion-${i}-err`)} message={err(`guion.${i}`)} />
          </div>
        ))}
        <FieldError id={id("guion-err")} message={err("guion")} />
        {d.guion.length < LAB_MAX_SCRIPT_MESSAGES && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set("guion", [...d.guion, ""])}
          >
            <Plus className="h-4 w-4" /> Agregar mensaje
          </Button>
        )}
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor={id("criterios")}>Criterios de éxito (opcional)</Label>
        <Textarea
          id={id("criterios")}
          rows={2}
          value={d.criteriosExito}
          placeholder="El juez evalúa contra esto. Ej.: no inventar plazos de garantía"
          onChange={(e) => set("criteriosExito", e.target.value)}
        />
        <FieldError id={id("criterios-err")} message={err("criteriosExito")} />
      </div>

      <details className="rounded-md border bg-card p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Ficha del contacto (opcional)
        </summary>
        <div className="mt-2 space-y-3">
          <div className="space-y-1">
            <Label htmlFor={id("seed-ficha")}>Ficha inicial (una línea «clave: valor»)</Label>
            <Textarea
              id={id("seed-ficha")}
              rows={2}
              value={d.seedFicha}
              placeholder="ciudad: Villahermosa"
              onChange={(e) => set("seedFicha", e.target.value)}
            />
            <FieldError id={id("seed-ficha-err")} message={err("seedFicha")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id("seed-notes")}>Notas iniciales</Label>
            <Textarea
              id={id("seed-notes")}
              rows={2}
              value={d.seedNotes}
              onChange={(e) => set("seedNotes", e.target.value)}
            />
            <FieldError id={id("seed-notes-err")} message={err("seedNotes")} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">
              Qué debe quedar en la ficha (expresión regular por campo)
            </legend>
            {d.expectFicha.map((r, i) => {
              const live = r.key || r.pattern ? validateExpectRule(r) : null;
              const message = err(`expect.${i}`) ?? live ?? undefined;
              return (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-[1fr_2fr_4rem_auto] items-center gap-2">
                    <Input
                      aria-label={`Clave de la regla ${i + 1}`}
                      placeholder="ciudad"
                      value={r.key}
                      onChange={(e) =>
                        set(
                          "expectFicha",
                          d.expectFicha.map((x, j) => (j === i ? { ...x, key: e.target.value } : x))
                        )
                      }
                    />
                    <Input
                      aria-label={`Patrón de la regla ${i + 1}`}
                      placeholder="villahermosa"
                      className="font-mono"
                      value={r.pattern}
                      aria-invalid={message ? true : undefined}
                      onChange={(e) =>
                        set(
                          "expectFicha",
                          d.expectFicha.map((x, j) =>
                            j === i ? { ...x, pattern: e.target.value } : x
                          )
                        )
                      }
                    />
                    <Input
                      aria-label={`Banderas de la regla ${i + 1}`}
                      placeholder="i"
                      className="font-mono"
                      value={r.flags}
                      onChange={(e) =>
                        set(
                          "expectFicha",
                          d.expectFicha.map((x, j) =>
                            j === i ? { ...x, flags: e.target.value } : x
                          )
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      aria-label={`Quitar regla ${i + 1}`}
                      onClick={() =>
                        set("expectFicha", d.expectFicha.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <FieldError id={id(`expect-${i}-err`)} message={message} />
                </div>
              );
            })}
            <FieldError id={id("expect-err")} message={err("expectFicha")} />
            {d.expectFicha.length < EXPECT_FICHA_MAX_RULES && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  set("expectFicha", [...d.expectFicha, { key: "", pattern: "", flags: "i" }])
                }
              >
                <Plus className="h-4 w-4" /> Agregar regla
              </Button>
            )}
          </fieldset>
        </div>
      </details>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          Activa
        </label>
        <div className="space-y-1">
          <Label htmlFor={id("position")} className="text-xs">
            Posición
          </Label>
          <Input
            id={id("position")}
            className="w-24"
            inputMode="numeric"
            value={d.position}
            onChange={(e) => set("position", e.target.value)}
          />
        </div>
        <FieldError id={id("position-err")} message={err("position")} />
      </div>

      {Object.keys(errors).length > 0 && (
        <p className="text-xs text-danger-text" role="alert">
          Revisa los campos marcados.
        </p>
      )}
      {error && (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Guardando…" : personaId ? "Guardar cambios" : "Crear persona"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
