"use client";

import { useEffect, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  APPOINTMENT_TYPE_LIMITS,
  validateTypeInput,
  type AppointmentTypeInput,
} from "@/lib/agenda-types";

/**
 * 023 — Ajustes → Agenda → Tipos de cita (US-1). Cada cambio se guarda por su
 * cuenta (casillas al instante; nombre, duración y orden al salir del campo),
 * no con el botón "Guardar" del horario. No se borra: se desactiva, porque las
 * citas viejas lo referencian.
 */

type AppointmentType = {
  id: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  position: number;
  active: boolean;
};

type Draft = { name: string; durationMinutes: string; position: string };

const { durationMinutes: DUR, name: NAME } = APPOINTMENT_TYPE_LIMITS;

function byPosition(a: AppointmentType, b: AppointmentType) {
  return a.position - b.position || a.name.localeCompare(b.name);
}

function draftOf(t: AppointmentType): Draft {
  return {
    name: t.name,
    durationMinutes: String(t.durationMinutes),
    position: String(t.position),
  };
}

async function errorMessage(res: Response | null, fallback: string) {
  if (!res) return "Sin conexión con el servidor.";
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return data?.error?.message ?? fallback;
}

export function AppointmentTypesCard() {
  const [types, setTypes] = useState<AppointmentType[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDuration, setNewDuration] = useState("30");
  const [newExclusive, setNewExclusive] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/calendar/types?all=1").catch(() => null);
      if (!res?.ok) {
        setLoadError(await errorMessage(res, "No se pudieron cargar los tipos."));
        setTypes([]);
        return;
      }
      const data = (await res.json()) as { types: AppointmentType[] };
      const sorted = [...data.types].sort(byPosition);
      setTypes(sorted);
      setDrafts(Object.fromEntries(sorted.map((t) => [t.id, draftOf(t)])));
    })();
  }, []);

  function replaceType(next: AppointmentType) {
    setTypes((list) =>
      list ? list.map((t) => (t.id === next.id ? next : t)).sort(byPosition) : list
    );
    setDrafts((d) => ({ ...d, [next.id]: draftOf(next) }));
  }

  async function patchType(t: AppointmentType, input: AppointmentTypeInput) {
    const check = validateTypeInput(input);
    if (!check.ok) {
      setRowError((e) => ({ ...e, [t.id]: check.message }));
      setDrafts((d) => ({ ...d, [t.id]: draftOf(t) }));
      return;
    }
    setBusy(t.id);
    setRowError((e) => {
      const rest = { ...e };
      delete rest[t.id];
      return rest;
    });
    const res = await fetch(`/api/calendar/types/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(check.value),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const message = await errorMessage(res, "No se pudo guardar el tipo.");
      setRowError((e) => ({ ...e, [t.id]: message }));
      setDrafts((d) => ({ ...d, [t.id]: draftOf(t) }));
      return;
    }
    const data = (await res.json()) as { type: AppointmentType };
    replaceType(data.type);
  }

  /** Nombre, duración y orden: se guardan al salir del campo si cambiaron. */
  function commitDraft(t: AppointmentType) {
    const d = drafts[t.id];
    if (!d) return;
    const input: AppointmentTypeInput = {};
    if (d.name.trim() !== t.name) input.name = d.name;
    const dur = Number(d.durationMinutes);
    if (dur !== t.durationMinutes) input.durationMinutes = dur;
    const pos = Number(d.position);
    if (pos !== t.position) input.position = pos;
    if (Object.keys(input).length === 0) return;
    void patchType(t, input);
  }

  function setDraft(id: string, next: Partial<Draft>) {
    setDrafts((d) => {
      const current = d[id];
      return current ? { ...d, [id]: { ...current, ...next } } : d;
    });
  }

  async function create() {
    const nextPosition =
      (types ?? []).reduce((max, t) => Math.max(max, t.position), -1) + 1;
    const check = validateTypeInput({
      name: newName,
      durationMinutes: Number(newDuration),
      exclusive: newExclusive,
      position: nextPosition,
    });
    if (!check.ok) {
      setCreateError(check.message);
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await fetch("/api/calendar/types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(check.value),
    }).catch(() => null);
    setCreating(false);
    if (res?.status !== 201) {
      setCreateError(await errorMessage(res, "No se pudo crear el tipo."));
      return;
    }
    const data = (await res.json()) as { type: AppointmentType };
    setTypes((list) => [...(list ?? []), data.type].sort(byPosition));
    setDrafts((d) => ({ ...d, [data.type.id]: draftOf(data.type) }));
    setNewName("");
    setNewDuration("30");
    setNewExclusive(false);
  }

  return (
    <Card data-testid="appointment-types-card">
      <CardHeader>
        <CardTitle>Tipos de cita</CardTitle>
        <CardDescription>
          Qué puede agendar un cliente y cuánto dura cada cosa. Un tipo
          desactivado deja de ofrecerse; sus citas existentes no cambian.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {types === null && <p className="text-sm text-text-3">Cargando…</p>}
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        {types && types.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-text-3">
                  <th scope="col" className="pb-2 pr-2 font-medium">
                    Orden
                  </th>
                  <th scope="col" className="pb-2 pr-2 font-medium">
                    Nombre
                  </th>
                  <th scope="col" className="pb-2 pr-2 font-medium">
                    Duración (min)
                  </th>
                  <th scope="col" className="pb-2 pr-2 font-medium">
                    <span title="Solo una a la vez en todo el negocio">
                      Exclusivo
                    </span>
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Activo
                  </th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => {
                  const d = drafts[t.id] ?? draftOf(t);
                  const err = rowError[t.id];
                  return (
                    <tr
                      key={t.id}
                      data-testid="appointment-type-row"
                      data-type-id={t.id}
                      className={cn("align-top", !t.active && "opacity-60")}
                    >
                      <td className="py-1 pr-2">
                        <Input
                          type="number"
                          min={0}
                          aria-label={`Orden de ${t.name}`}
                          value={d.position}
                          disabled={busy === t.id}
                          onChange={(e) =>
                            setDraft(t.id, { position: e.target.value })
                          }
                          onBlur={() => commitDraft(t)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitDraft(t);
                          }}
                          className="w-16"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <Input
                          aria-label={`Nombre de ${t.name}`}
                          value={d.name}
                          maxLength={NAME.max}
                          disabled={busy === t.id}
                          onChange={(e) => setDraft(t.id, { name: e.target.value })}
                          onBlur={() => commitDraft(t)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitDraft(t);
                          }}
                        />
                        {err && (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {err}
                          </p>
                        )}
                      </td>
                      <td className="py-1 pr-2">
                        <Input
                          type="number"
                          min={DUR.min}
                          max={DUR.max}
                          aria-label={`Duración de ${t.name} en minutos`}
                          value={d.durationMinutes}
                          disabled={busy === t.id}
                          onChange={(e) =>
                            setDraft(t.id, { durationMinutes: e.target.value })
                          }
                          onBlur={() => commitDraft(t)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitDraft(t);
                          }}
                          className="w-24"
                        />
                      </td>
                      <td className="py-1 pr-2 pt-3">
                        <input
                          type="checkbox"
                          aria-label={`${t.name}: exclusivo (solo una a la vez en todo el negocio)`}
                          checked={t.exclusive}
                          disabled={busy === t.id}
                          onChange={(e) =>
                            void patchType(t, { exclusive: e.target.checked })
                          }
                          className="h-4 w-4 accent-primary"
                        />
                      </td>
                      <td className="py-1 pt-3">
                        <input
                          type="checkbox"
                          aria-label={`${t.name}: activo`}
                          checked={t.active}
                          disabled={busy === t.id}
                          onChange={(e) =>
                            void patchType(t, { active: e.target.checked })
                          }
                          className="h-4 w-4 accent-primary"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-text-3">
          Exclusivo: solo una a la vez en todo el negocio, aunque la agenden
          vendedores distintos (p. ej. la prueba de manejo con el único auto
          demo). El orden es el número más bajo primero.
        </p>

        <div className="space-y-2 rounded-sm border border-dashed p-3">
          <p className="text-sm font-medium">Agregar un tipo</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[160px] flex-1 space-y-1.5">
              <Label htmlFor="new-type-name">Nombre</Label>
              <Input
                id="new-type-name"
                data-testid="appointment-type-new-name"
                value={newName}
                maxLength={NAME.max}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ej. Avalúo"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-type-duration">Duración (min)</Label>
              <Input
                id="new-type-duration"
                data-testid="appointment-type-new-duration"
                type="number"
                min={DUR.min}
                max={DUR.max}
                value={newDuration}
                onChange={(e) => setNewDuration(e.target.value)}
                className="w-24"
              />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={newExclusive}
                onChange={(e) => setNewExclusive(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Exclusivo
            </label>
            <Button
              variant="secondary"
              data-testid="appointment-type-add"
              onClick={() => void create()}
              disabled={creating || !newName.trim()}
            >
              {creating ? "Agregando…" : "Agregar"}
            </Button>
          </div>
          {createError && (
            <p role="alert" className="text-xs text-destructive">
              {createError}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
