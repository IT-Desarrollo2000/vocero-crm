"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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

/**
 * 016 — Ajustes → Anuncios: conectar el dataset de Meta, decir qué etapa
 * significa "lead calificado" y ver qué se le ha reportado.
 */

type Capi = {
  datasetId: string;
  status: "connected" | "error";
  tokenLast4: string;
  qualifiedStageId: string | null;
};

type Stage = { id: string; name: string; kind: "open" | "won" | "lost" };

type ActivityRow = {
  id: string;
  eventName: string;
  contactName: string | null;
  adHeadline: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  at: string;
  fbTraceId: string | null;
  error: string | null;
  /** El servidor decide qué se puede reintentar; aquí solo se pinta. */
  retryable: boolean;
};

const STATUS_LABEL: Record<ActivityRow["status"], string> = {
  sent: "Enviado",
  failed: "Falló",
  skipped: "Omitido",
  pending: "En curso",
};

const STATUS_VARIANT: Record<
  ActivityRow["status"],
  "success" | "destructive" | "secondary"
> = {
  sent: "success",
  failed: "destructive",
  skipped: "secondary",
  pending: "secondary",
};

/** Qué significa cada evento, en el idioma del negocio y no en el de Meta. */
const EVENT_LABEL: Record<string, string> = {
  QualifiedLead: "Lead calificado",
  Purchase: "Venta",
};

export function AdsClient() {
  const [capi, setCapi] = useState<Capi | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [token, setToken] = useState("");
  const [qualifiedStageId, setQualifiedStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Filas con un reintento en curso (cada una con su propio "ocupado"). */
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  /** Error del último reintento, por fila. */
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [retryingAll, setRetryingAll] = useState(false);
  const [retryAllNote, setRetryAllNote] = useState<string | null>(null);

  const loadActivity = useCallback(async () => {
    const res = await fetch("/api/settings/capi/events").catch(() => null);
    if (!res?.ok) return setActivity([]);
    const data = (await res.json()) as { events: ActivityRow[] };
    setActivity(data.events);
  }, []);

  useEffect(() => {
    void (async () => {
      const [cfg, stg] = await Promise.all([
        fetch("/api/settings/capi").catch(() => null),
        fetch("/api/pipeline/stages").catch(() => null),
      ]);
      if (cfg?.ok) {
        const data = (await cfg.json()) as { capi: Capi | null };
        setCapi(data.capi);
        setDatasetId(data.capi?.datasetId ?? "");
        setQualifiedStageId(data.capi?.qualifiedStageId ?? "");
      }
      if (stg?.ok) {
        const data = (await stg.json()) as { stages: Stage[] };
        setStages(data.stages);
      }
      await loadActivity();
    })();
  }, [loadActivity]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/capi", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetId: datasetId.trim(),
        // Vacío = reusar el token de WhatsApp. Se omite en vez de mandar "".
        ...(token.trim() ? { token: token.trim() } : {}),
        qualifiedStageId: qualifiedStageId || null,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "No se pudo guardar");
      return;
    }
    setToken("");
    setSaved(true);
    const cfg = await fetch("/api/settings/capi").catch(() => null);
    if (cfg?.ok) {
      const data = (await cfg.json()) as { capi: Capi | null };
      setCapi(data.capi);
    }
  }

  async function disconnect() {
    setSaving(true);
    await fetch("/api/settings/capi", { method: "DELETE" }).catch(() => null);
    setSaving(false);
    setCapi(null);
    setDatasetId("");
    setToken("");
    setQualifiedStageId("");
    setSaved(false);
  }

  async function retry(id: string) {
    setRetrying((prev) => new Set(prev).add(id));
    setRetryErrors(({ [id]: _omit, ...rest }) => rest);
    const res = await fetch(`/api/settings/capi/events/${id}/retry`, {
      method: "POST",
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as
      | { event?: ActivityRow | null; error?: { message?: string } }
      | null;
    setRetrying((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (!res?.ok) {
      setRetryErrors((prev) => ({
        ...prev,
        [id]: body?.error?.message ?? "No se pudo reintentar",
      }));
      // Un 409 suele significar que la fila cambió por otro lado: se recarga
      // para mostrar su estado real.
      if (res?.status === 409) await loadActivity();
      return;
    }
    const event = body?.event;
    if (event) {
      setActivity((prev) =>
        prev ? prev.map((r) => (r.id === id ? event : r)) : prev
      );
    } else {
      await loadActivity();
    }
  }

  async function retryAll() {
    setRetryingAll(true);
    setRetryAllNote(null);
    const res = await fetch("/api/settings/capi/events/retry", {
      method: "POST",
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as
      | { attempted: number; sent: number; failed: number; skipped: number }
      | null;
    setRetryingAll(false);
    setRetryAllNote(
      res?.ok && body
        ? `Reintentadas: ${body.attempted} · enviadas: ${body.sent} · fallidas: ${body.failed} · omitidas: ${body.skipped}`
        : "No se pudieron reintentar"
    );
    await loadActivity();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Conversiones de anuncios</CardTitle>
          <CardDescription>
            Meta sabe qué conversaciones empezaron desde un anuncio, pero no
            cuáles sirvieron. Conecta tu dataset y el CRM le avisará cuándo un
            lead se califica y cuándo se cierra la venta, para que optimice
            hacia quien compra y no hacia quien solo escribe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {capi ? (
            <p className="text-sm text-muted-foreground">
              Conectado al dataset{" "}
              <span className="font-medium text-foreground">
                {capi.datasetId}
              </span>{" "}
              · token ····{capi.tokenLast4}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="capi-dataset">ID del dataset</Label>
            <Input
              id="capi-dataset"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              placeholder="1708105527110154"
            />
            <p className="text-xs text-muted-foreground">
              Administrador de eventos de Meta → tu conjunto de datos. Suele ser
              el de tu propia cuenta de WhatsApp.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-token">Token (opcional)</Label>
            <Input
              id="capi-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Déjalo vacío para reusar el de WhatsApp"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              El token de tu conexión de WhatsApp ya suele poder publicar en el
              dataset. Solo pega uno si Meta te dio otro distinto.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="capi-stage">¿Qué etapa es un lead calificado?</Label>
            <select
              id="capi-stage"
              value={qualifiedStageId}
              onChange={(e) => setQualifiedStageId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">No reportar leads calificados</option>
              {stages
                .filter((s) => s.kind === "open")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <p className="text-xs text-muted-foreground">
              La venta se reporta sola cuando el trato entra a tu etapa ganada.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="text-sm text-success-text">Guardado.</p>
          ) : null}

          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !datasetId.trim()}>
              {saving ? "Guardando…" : "Guardar"}
            </Button>
            {capi ? (
              <Button variant="outline" onClick={disconnect} disabled={saving}>
                Desconectar
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actividad reciente</CardTitle>
          <CardDescription>
            Lo último que se le reportó a Meta. Si algo no salió, aquí dice por
            qué — es la forma de saber si esto funciona, sin salir del CRM.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void loadActivity()}>
              Actualizar
            </Button>
            {activity?.some((r) => r.retryable) ? (
              <Button
                variant="outline"
                onClick={() => void retryAll()}
                disabled={retryingAll || retrying.size > 0}
              >
                {retryingAll ? "Reintentando…" : "Reintentar pendientes"}
              </Button>
            ) : null}
          </div>
          {retryAllNote ? (
            <p className="text-xs text-muted-foreground" role="status">
              {retryAllNote}
            </p>
          ) : null}
          {activity === null ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todavía no hay conversiones. Aparecerán cuando un lead que llegó
              por un anuncio avance de etapa.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Evento</th>
                    <th className="py-2 pr-3 font-medium">Contacto</th>
                    <th className="py-2 pr-3 font-medium">Estado</th>
                    <th className="py-2 pr-3 font-medium">Cuándo</th>
                    <th className="py-2 font-medium">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="py-2 pr-3">
                        {EVENT_LABEL[row.eventName] ?? row.eventName}
                        {row.adHeadline ? (
                          <span className="block text-xs text-muted-foreground">
                            {row.adHeadline}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{row.contactName ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {new Date(row.at).toLocaleString()}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {row.error ?? row.fbTraceId ?? "—"}
                        {row.retryable ? (
                          <div className="mt-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void retry(row.id)}
                              disabled={retrying.has(row.id) || retryingAll}
                            >
                              {retrying.has(row.id)
                                ? "Reintentando…"
                                : "Reintentar"}
                            </Button>
                          </div>
                        ) : null}
                        {retryErrors[row.id] ? (
                          <span
                            className="mt-1 block text-danger-text"
                            role="alert"
                          >
                            {retryErrors[row.id]}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
