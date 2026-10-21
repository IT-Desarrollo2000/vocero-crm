"use client";

import { useEffect, useState } from "react";
import {
  AUTO_ARCHIVE_DEFAULT_DAYS,
  AUTO_ARCHIVE_MAX_DAYS,
  AUTO_ARCHIVE_MIN_DAYS,
  type InboxSettingsDto,
} from "@/lib/inbox-settings";
import {
  OVERDUE_DEFAULT_MINUTES,
  OVERDUE_MAX_MINUTES,
  OVERDUE_MIN_MINUTES,
} from "@/lib/awaiting";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApiErrorBody = { error?: { message?: string } } | null;

/** Días válidos (1–365, enteros) o null si lo escrito no sirve. */
function parseDays(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= AUTO_ARCHIVE_MIN_DAYS && n <= AUTO_ARCHIVE_MAX_DAYS ? n : null;
}

function conversaciones(n: number): string {
  return n === 1 ? "1 conversación" : `${n} conversaciones`;
}

async function errorMessage(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "Sin conexión con el servidor.";
  const data = (await res.json().catch(() => null)) as ApiErrorBody;
  return data?.error?.message ?? fallback;
}

const DAYS_HINT = `Entre ${AUTO_ARCHIVE_MIN_DAYS} y ${AUTO_ARCHIVE_MAX_DAYS} días.`;

/** 026: minutos válidos (5–1440, enteros) o null si lo escrito no sirve. */
function parseMinutes(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= OVERDUE_MIN_MINUTES && n <= OVERDUE_MAX_MINUTES ? n : null;
}

const MINUTES_HINT = `Entre ${OVERDUE_MIN_MINUTES} y ${OVERDUE_MAX_MINUTES} minutos (24 h).`;

/**
 * 022 — Ajustes → Bandeja (solo Propietario). Archivado automático de
 * conversaciones inactivas y limpieza en dos pasos (calcular → confirmar).
 * Archivar nunca borra: el historial, los reportes y la atribución quedan.
 *
 * 026 — Umbral de "atrasada" de la vista Por atender. Va en el MISMO PUT que
 * el auto-archivo (el schema lo pone en 60 si falta): cada tarjeta guarda los
 * tres valores para no pisar la otra.
 */
export function InboxSettingsClient() {
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // 026: Por atender.
  const [overdue, setOverdue] = useState(String(OVERDUE_DEFAULT_MINUTES));
  const [savingOverdue, setSavingOverdue] = useState(false);
  const [savedOverdue, setSavedOverdue] = useState(false);
  const [overdueError, setOverdueError] = useState<string | null>(null);
  // Lo último guardado/cargado de cada tarjeta: guardar una no manda lo que
  // se está editando (sin guardar) en la otra.
  const [stored, setStored] = useState<InboxSettingsDto>({
    autoArchiveEnabled: false,
    autoArchiveDays: AUTO_ARCHIVE_DEFAULT_DAYS,
    overdueMinutes: OVERDUE_DEFAULT_MINUTES,
  });

  // Archivado automático.
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(String(AUTO_ARCHIVE_DEFAULT_DAYS));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Limpieza ahora.
  const [cleanDays, setCleanDays] = useState(String(AUTO_ARCHIVE_DEFAULT_DAYS));
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState<"count" | "archive" | null>(null);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/inbox")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { settings?: InboxSettingsDto } | null) => {
        if (d?.settings) {
          setEnabled(d.settings.autoArchiveEnabled);
          setDays(String(d.settings.autoArchiveDays));
          setCleanDays(String(d.settings.autoArchiveDays));
          // Servidor anterior a 026 (sin el campo): el default.
          const minutes = d.settings.overdueMinutes ?? OVERDUE_DEFAULT_MINUTES;
          setOverdue(String(minutes));
          setStored({ ...d.settings, overdueMinutes: minutes });
        } else {
          setLoadFailed(true);
        }
        setLoaded(true);
      })
      .catch(() => {
        setLoadFailed(true);
        setLoaded(true);
      });
  }, []);

  const parsedDays = parseDays(days);
  const parsedCleanDays = parseDays(cleanDays);

  const parsedOverdue = parseMinutes(overdue);

  /** PUT con los tres valores (`patch` = lo de la tarjeta que guarda). */
  async function put(patch: Partial<InboxSettingsDto>): Promise<string | null> {
    const body: InboxSettingsDto = { ...stored, ...patch };
    const res = await fetch("/api/settings/inbox", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) return errorMessage(res, "No se pudo guardar.");
    setStored(body);
    return null;
  }

  async function save() {
    if (parsedDays === null) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    const error = await put({ autoArchiveEnabled: enabled, autoArchiveDays: parsedDays });
    setSaving(false);
    if (error) {
      setSaveError(error);
      return;
    }
    setSaved(true);
  }

  async function saveOverdue() {
    if (parsedOverdue === null) return;
    setSavingOverdue(true);
    setSavedOverdue(false);
    setOverdueError(null);
    const error = await put({ overdueMinutes: parsedOverdue });
    setSavingOverdue(false);
    if (error) {
      setOverdueError(error);
      return;
    }
    setSavedOverdue(true);
  }

  async function runCleanup(dryRun: boolean) {
    if (parsedCleanDays === null) return;
    setBusy(dryRun ? "count" : "archive");
    setCleanError(null);
    setArchivedCount(null);
    const res = await fetch("/api/conversations/archive-inactive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: parsedCleanDays, dryRun }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setCleanError(
        await errorMessage(
          res,
          dryRun ? "No se pudo calcular." : "No se pudieron archivar las conversaciones."
        )
      );
      return;
    }
    const data = (await res.json().catch(() => null)) as { count?: number } | null;
    const count = typeof data?.count === "number" ? data.count : 0;
    if (dryRun) {
      setPreview(count);
    } else {
      setPreview(null);
      setArchivedCount(count);
    }
  }

  if (!loaded) return <p className="text-sm text-text-3">Cargando…</p>;

  return (
    <div className="max-w-2xl space-y-6">
      {loadFailed && (
        <p role="alert" className="text-sm text-destructive">
          No se pudieron cargar los ajustes de la Bandeja. Se muestran los
          valores por defecto.
        </p>
      )}

      <section aria-label="Por atender">
        <Card>
          <CardHeader>
            <CardTitle>Por atender</CardTitle>
            <CardDescription>
              Los chats en manos de una persona muestran cuánto lleva el
              cliente esperando respuesta: en ámbar mientras tanto y en rojo
              al pasar este tiempo. Aplica a todo el equipo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="overdue-minutes">
                Marcar como atrasada tras (minutos)
              </Label>
              <Input
                id="overdue-minutes"
                type="number"
                inputMode="numeric"
                min={OVERDUE_MIN_MINUTES}
                max={OVERDUE_MAX_MINUTES}
                step={1}
                value={overdue}
                onChange={(e) => {
                  setOverdue(e.target.value);
                  setSavedOverdue(false);
                }}
                aria-invalid={parsedOverdue === null}
                aria-describedby="overdue-minutes-hint"
                className="max-w-[8rem]"
              />
              <p id="overdue-minutes-hint" className="text-xs text-text-3">
                {parsedOverdue === null ? (
                  <span className="text-destructive">{MINUTES_HINT}</span>
                ) : (
                  MINUTES_HINT
                )}
              </p>
            </div>
            {overdueError && (
              <p role="alert" className="text-sm text-destructive">
                {overdueError}
              </p>
            )}
            {savedOverdue && (
              <p role="status" className="text-sm text-brand-text">
                Umbral guardado ✓ (se ve en la Bandeja al recargarla)
              </p>
            )}
            <Button
              disabled={savingOverdue || parsedOverdue === null}
              onClick={() => void saveOverdue()}
            >
              {savingOverdue ? "Guardando…" : "Guardar"}
            </Button>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Archivado automático">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>Archivado automático</CardTitle>
                <CardDescription>
                  Saca de la Bandeja las conversaciones que llevan días sin
                  mensajes de nadie. Archivar no borra nada: siguen en
                  Archivadas y en la búsqueda.
                </CardDescription>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Archivar automáticamente conversaciones inactivas"
                onClick={() => {
                  setEnabled((v) => !v);
                  setSaved(false);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                  enabled ? "bg-brand" : "bg-border-strong"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full bg-knob shadow-sm transition-transform ${
                    enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="auto-archive-days">Días sin actividad</Label>
              <Input
                id="auto-archive-days"
                type="number"
                inputMode="numeric"
                min={AUTO_ARCHIVE_MIN_DAYS}
                max={AUTO_ARCHIVE_MAX_DAYS}
                step={1}
                value={days}
                onChange={(e) => {
                  setDays(e.target.value);
                  setSaved(false);
                }}
                aria-invalid={parsedDays === null}
                aria-describedby="auto-archive-days-hint"
                className="max-w-[8rem]"
              />
              <p id="auto-archive-days-hint" className="text-xs text-text-3">
                {parsedDays === null ? (
                  <span className="text-destructive">{DAYS_HINT}</span>
                ) : (
                  DAYS_HINT
                )}
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border bg-secondary p-3 text-xs text-text-2">
              <p>
                <strong className="font-medium">Inactiva</strong> = sin mensajes
                entrantes ni salientes durante esos días (si nunca tuvo
                mensajes, se cuenta desde que se creó).
              </p>
              <p>Nunca se archivan:</p>
              <ul className="list-disc space-y-0.5 pl-5">
                <li>las que tienen una cita futura agendada;</li>
                <li>
                  las de un lead en una etapa marcada &quot;No archivar&quot;
                  (se marca en Seguimiento → Etapas);
                </li>
                <li>las que quedaron por atender dentro de esos días.</li>
              </ul>
              <p>
                Un mensaje nuevo del cliente, o uno que envíes tú, la regresa a
                la Bandeja.
              </p>
            </div>

            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            {saved && (
              <p role="status" className="text-sm text-brand-text">
                Ajustes guardados ✓
              </p>
            )}
            <Button disabled={saving || parsedDays === null} onClick={() => void save()}>
              {saving ? "Guardando…" : "Guardar"}
            </Button>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Limpiar inactivas ahora">
        <Card>
          <CardHeader>
            <CardTitle>Limpiar inactivas ahora</CardTitle>
            <CardDescription>
              Archiva de una vez las conversaciones sin actividad, con las
              mismas excepciones. Primero calcula cuántas son y luego confirma.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cleanup-days">Días de inactividad para limpiar</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="cleanup-days"
                  type="number"
                  inputMode="numeric"
                  min={AUTO_ARCHIVE_MIN_DAYS}
                  max={AUTO_ARCHIVE_MAX_DAYS}
                  step={1}
                  value={cleanDays}
                  onChange={(e) => {
                    setCleanDays(e.target.value);
                    // El conteo era para otros días: hay que recalcular.
                    setPreview(null);
                    setArchivedCount(null);
                  }}
                  aria-invalid={parsedCleanDays === null}
                  aria-describedby="cleanup-days-hint"
                  className="max-w-[8rem]"
                />
                <Button
                  variant="outline"
                  disabled={busy !== null || parsedCleanDays === null}
                  onClick={() => void runCleanup(true)}
                >
                  {busy === "count" ? "Calculando…" : "Calcular"}
                </Button>
              </div>
              <p id="cleanup-days-hint" className="text-xs text-text-3">
                {parsedCleanDays === null ? (
                  <span className="text-destructive">{DAYS_HINT}</span>
                ) : (
                  DAYS_HINT
                )}
              </p>
            </div>

            {preview !== null && (
              <div className="flex flex-wrap items-center gap-3">
                <p role="status" className="text-sm">
                  {preview === 0
                    ? "No hay conversaciones para archivar."
                    : preview === 1
                      ? "Se archivará 1 conversación."
                      : `Se archivarán ${preview} conversaciones.`}
                </p>
                <Button
                  disabled={busy !== null || preview === 0}
                  onClick={() => void runCleanup(false)}
                >
                  {busy === "archive" ? "Archivando…" : `Archivar ${conversaciones(preview)}`}
                </Button>
              </div>
            )}

            {archivedCount !== null && (
              <p role="status" className="text-sm text-brand-text">
                {archivedCount === 1
                  ? "Se archivó 1 conversación."
                  : `Se archivaron ${archivedCount} conversaciones.`}
              </p>
            )}
            {cleanError && (
              <p role="alert" className="text-sm text-destructive">
                {cleanError}
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
