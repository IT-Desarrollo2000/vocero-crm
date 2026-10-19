"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { StageDto } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 022: qué hace la casilla "No archivar" (tooltip y texto en pantallas anchas). */
const KEEP_ACTIVE_HINT = "sus conversaciones no se archivan por inactividad";

/** Gestión de etapas: renombrar, reordenar, agregar, eliminar (con reasignación). */
export function StageManager({
  stages,
  onClose,
  onChanged,
}: {
  stages: StageDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<StageDto | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 022: valor optimista de "No archivar" mientras vuelve la lista. */
  const [keepActive, setKeepActive] = useState<Record<string, boolean>>({});

  async function toggleKeepActive(stage: StageDto, value: boolean) {
    setError(null);
    setKeepActive((m) => ({ ...m, [stage.id]: value }));
    const res = await fetch(`/api/pipeline/stages/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepActive: value }),
    }).catch(() => null);
    if (!res?.ok) {
      setKeepActive((m) => ({ ...m, [stage.id]: stage.keepActive }));
      setError(`No se pudo cambiar "No archivar" en "${stage.name}".`);
      return;
    }
    onChanged();
  }

  async function rename(stage: StageDto, name: string) {
    if (!name.trim() || name === stage.name) return;
    await fetch(`/api/pipeline/stages/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    onChanged();
  }

  async function move(stage: StageDto, dir: -1 | 1) {
    const sorted = [...stages].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === stage.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    await Promise.all([
      fetch(`/api/pipeline/stages/${stage.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: swap.position }),
      }),
      fetch(`/api/pipeline/stages/${swap.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: stage.position }),
      }),
    ]).catch(() => null);
    onChanged();
  }

  async function add() {
    if (!newName.trim()) return;
    await fetch("/api/pipeline/stages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    }).catch(() => null);
    setNewName("");
    onChanged();
  }

  async function remove(stage: StageDto, moveToId: string | null) {
    setError(null);
    const url = moveToId
      ? `/api/pipeline/stages/${stage.id}?moveTo=${moveToId}`
      : `/api/pipeline/stages/${stage.id}`;
    const res = await fetch(url, { method: "DELETE" }).catch(() => null);
    if (!res) return;
    if (res.status === 409) {
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      if (data?.error?.code === "stage_has_leads") {
        setDeleting(stage);
        return;
      }
      setError(data?.error?.message ?? "No se pudo eliminar");
      return;
    }
    setDeleting(null);
    setMoveTo("");
    onChanged();
  }

  const sorted = [...stages].sort((a, b) => a.position - b.position);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-semibold">Etapas de seguimiento</h3>
        <ul className="space-y-2">
          {sorted.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Input
                defaultValue={s.name}
                onBlur={(e) => void rename(s, e.target.value)}
                className="min-w-0 flex-1"
              />
              {s.kind !== "open" ? (
                <Badge variant={s.kind === "won" ? "success" : "secondary"}>
                  {s.kind === "won" ? "ganado" : "perdido"}
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Eliminar etapa"
                  onClick={() => void remove(s, null)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                disabled={i === 0}
                aria-label="Subir"
                onClick={() => void move(s, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={i === sorted.length - 1}
                aria-label="Bajar"
                onClick={() => void move(s, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              {/* 022: segunda línea para no apretar la fila en 360 px. */}
              <label
                className="flex basis-full cursor-pointer items-center gap-1.5 pl-1 text-xs text-text-3"
                title={KEEP_ACTIVE_HINT}
              >
                <input
                  type="checkbox"
                  checked={keepActive[s.id] ?? s.keepActive}
                  onChange={(e) => void toggleKeepActive(s, e.target.checked)}
                  aria-label={`No archivar automáticamente "${s.name}"`}
                  className="accent-primary"
                />
                No archivar
                <span className="max-sm:hidden">— {KEEP_ACTIVE_HINT}</span>
              </label>
            </li>
          ))}
        </ul>

        {deleting && (
          <div className="mt-4 rounded-md border border-warning-soft bg-warning-tint p-3">
            <p className="text-sm text-warning-text">
              &quot;{deleting.name}&quot; tiene tarjetas. Elige a dónde moverlas:
            </p>
            <div className="mt-2 flex gap-2">
              <select
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
                className="h-9 flex-1 rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="">Etapa destino…</option>
                {sorted
                  .filter((s) => s.id !== deleting.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <Button
                variant="destructive"
                size="sm"
                disabled={!moveTo}
                onClick={() => void remove(deleting, moveTo)}
              >
                Mover y eliminar
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex gap-2 border-t pt-4">
          <Input
            placeholder="Nueva etapa…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <Button onClick={() => void add()} disabled={!newName.trim()}>
            Agregar
          </Button>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
