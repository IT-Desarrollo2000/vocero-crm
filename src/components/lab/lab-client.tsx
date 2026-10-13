"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Play,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useEvents } from "@/components/use-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fichaCheckView } from "@/components/ficha-view";
import type { FichaCheck } from "@/lib/ficha-fields";
import { LAB_AJUSTE_CAMPOS, LAB_MAX_PERSONAS_PER_RUN } from "@/lib/lab";
import type {
  LabAjusteCampo,
  LabAppliedDto,
  LabHallazgoDto,
  LabPersonaDto,
  LabPersonasResponse,
  LabRunCaseDto,
  LabRunSummaryDto,
  LabSuggestionApplyResultDto,
} from "@/lib/types";
import { labFetch } from "./lab-fetch";
import {
  PROFILE_FIELD_LABELS,
  TIPO_LABELS,
  defaultSelection,
  deltaView,
  pruneSelection,
  runCreateBody,
  runnablePersonas,
  toggleSelection,
  tooLongMessage,
} from "./lab-logic";
import { PersonasPanel, type PersonasState } from "./personas-panel";
import { RunInsights } from "./run-insights";

/** Detalle de `GET /api/lab/runs/[id]` (sin delta: ese viene del listado). */
type RunDetail = Pick<
  LabRunSummaryDto,
  "id" | "status" | "score" | "error" | "startedAt" | "finishedAt" | "personaKeys"
>;

export function LabClient() {
  const [runs, setRuns] = useState<LabRunSummaryDto[]>([]);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: RunDetail; cases: LabRunCaseDto[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personas, setPersonas] = useState<PersonasState>({ status: "loading" });
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetchRuns = useCallback(async () => {
    const res = await fetch("/api/lab/runs").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { runs: LabRunSummaryDto[]; aiConfigured: boolean };
    setRuns(data.runs);
    setAiConfigured(data.aiConfigured);
    // Funcional: tras eliminar la corrida seleccionada, el closure aún vería
    // el id viejo y no auto-seleccionaría la siguiente.
    setSelectedRunId((prev) => prev ?? data.runs[0]?.id ?? null);
  }, []);

  const refetchDetail = useCallback(async (runId: string) => {
    const res = await fetch(`/api/lab/runs/${runId}`).catch(() => null);
    if (res?.status === 404) {
      // Eliminada (p. ej. desde otra pestaña): suelta el detalle y la
      // selección para que el historial elija la siguiente.
      setDetail(null);
      setSelectedRunId((prev) => (prev === runId ? null : prev));
      void refetchRuns();
      return;
    }
    if (!res?.ok) return;
    setDetail((await res.json()) as { run: RunDetail; cases: LabRunCaseDto[] });
  }, [refetchRuns]);

  /** Lista activas + archivadas en una sola llamada (se separan en cliente). */
  const applyPersonas = useCallback(
    (list: LabPersonaDto[], runInProgress: boolean) => {
      setPersonas({ status: "ready", personas: list, runInProgress });
      if (selectionTouched) {
        setSelected((prev) => pruneSelection(prev, list));
      } else {
        const def = defaultSelection(list);
        setSelected(def.keys);
        setSelectionNotice(
          def.capped
            ? `Hay más de ${LAB_MAX_PERSONAS_PER_RUN} activas: se eligieron las primeras ${LAB_MAX_PERSONAS_PER_RUN}.`
            : null
        );
      }
    },
    [selectionTouched]
  );

  const refetchPersonas = useCallback(async () => {
    const res = await labFetch<LabPersonasResponse>(
      "/api/lab/personas?archived=1",
      undefined,
      "No se pudieron cargar las personas"
    );
    if (res.ok) {
      applyPersonas(res.data.personas, res.data.runInProgress);
      return;
    }
    if (res.outcome.kind === "not_implemented") setPersonas({ status: "unavailable" });
    else setPersonas({ status: "error", message: res.outcome.message });
  }, [applyPersonas]);

  async function removeRun(runId: string): Promise<string | null> {
    const res = await fetch(`/api/lab/runs/${runId}`, { method: "DELETE" }).catch(
      () => null
    );
    if (!res) return "No se pudo eliminar la evaluación";
    if (!res.ok && res.status !== 404) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return data?.error?.message ?? "No se pudo eliminar la evaluación";
    }
    // 404: ya no existía — se trata como eliminada y se refresca la lista.
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setDetail(null);
    }
    await refetchRuns();
    setRefreshKey((k) => k + 1);
    return null;
  }

  useEffect(() => {
    void refetchRuns();
  }, [refetchRuns]);

  useEffect(() => {
    void refetchPersonas();
    // Solo al montar: luego recarga tras cada cambio de personas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedRunId) void refetchDetail(selectedRunId);
  }, [selectedRunId, refetchDetail]);

  useEvents({
    onLabRun: (data) => {
      setProgress(data.status === "running" ? data.progress : null);
      void refetchRuns();
      if (data.status !== "running") {
        setRefreshKey((k) => k + 1);
        void refetchPersonas();
      }
      if (selectedRunId === data.runId || !selectedRunId) {
        setSelectedRunId(data.runId);
        void refetchDetail(data.runId);
      }
    },
  });

  const personaList = personas.status === "ready" ? personas.personas : null;

  function toggle(key: string) {
    setSelectionTouched(true);
    const r = toggleSelection(selected, key);
    setSelected(r.keys);
    setSelectionNotice(
      r.limited
        ? `Máximo ${LAB_MAX_PERSONAS_PER_RUN} personas por corrida: desmarca otra primero.`
        : null
    );
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    const body = runCreateBody(selected, personaList);
    const res = await labFetch<{ runId: string }>(
      "/api/lab/runs",
      { method: "POST", ...(body ? { body } : {}) },
      "No se pudo lanzar la corrida"
    );
    setLaunching(false);
    if (!res.ok) {
      setError(
        res.outcome.kind === "not_implemented"
          ? "Disponible pronto: elegir personas por corrida. Por ahora marca todas las activas para correr."
          : res.outcome.message
      );
      return;
    }
    setSelectedRunId(res.data.runId);
    const total = body?.personaKeys?.length ??
      (personaList ? Math.min(runnablePersonas(personaList).length, LAB_MAX_PERSONAS_PER_RUN) : null);
    setProgress(total ? { done: 0, total } : null);
    void refetchRuns();
  }

  const personaNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of personaList ?? []) names.set(p.key, p.name);
    for (const c of detail?.cases ?? []) {
      if (!names.has(c.persona)) names.set(c.persona, c.personaLabel);
    }
    return names;
  }, [personaList, detail]);
  const personaName = useCallback(
    (key: string) => personaNames.get(key) ?? key,
    [personaNames]
  );

  if (!aiConfigured) {
    return (
      <div className="flex h-full flex-col">
        <Header running={false} launching={false} onLaunch={() => {}} disabled reason={null} />
        <div className="m-6 rounded-lg border border-brand-soft bg-brand-tint p-8 text-center">
          <Sparkles className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="font-medium">
            Configura tu proveedor de IA para usar el Laboratorio
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            El Laboratorio necesita el agente activo: agrega{" "}
            <code className="rounded bg-secondary px-1">OPENROUTER_API_TOKEN</code> a la
            instancia y vuelve aquí.
          </p>
        </div>
      </div>
    );
  }

  const running = runs.some((r) => r.status === "running");
  const noneSelected = personaList !== null && selected.length === 0;
  const noneActive = personaList !== null && runnablePersonas(personaList).length === 0;
  const selectedSummary = runs.find((r) => r.id === detail?.run.id) ?? null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Header
        running={running}
        launching={launching}
        onLaunch={() => void launch()}
        disabled={noneSelected}
        reason={
          noneActive
            ? "No hay personas activas: crea una o restaura las predeterminadas."
            : noneSelected
              ? "Elige al menos una persona para correr."
              : null
        }
      />
      {error && (
        <p className="px-4 pt-3 text-sm text-destructive sm:px-6" role="alert">
          {error}
        </p>
      )}

      {running && progress && (
        <div className="mx-6 mt-4 rounded-lg border bg-card p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">Evaluando personas…</span>
            <span className="text-muted-foreground">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
            />
          </div>
        </div>
      )}

      <PersonasPanel
        state={personas}
        selected={selected}
        selectionNotice={selectionNotice}
        onToggle={toggle}
        onReload={refetchPersonas}
      />

      <div className="grid gap-4 p-4 sm:gap-6 sm:p-6 lg:grid-cols-[280px_1fr]">
        <HistoryList
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
          onDelete={removeRun}
        />
        {detail ? (
          <Report
            detail={detail}
            againstId={selectedSummary?.deltaAgainst ?? null}
            refreshKey={refreshKey}
            personaName={personaName}
            onApplied={() => void refetchDetail(detail.run.id)}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {runs.length === 0
              ? "Corre tu primera evaluación: tus personas (clientes simulados) conversarán con tu agente y un juez calificará cada conversación."
              : "Elige una corrida del historial."}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({
  running,
  launching,
  onLaunch,
  disabled,
  reason,
}: {
  running: boolean;
  launching: boolean;
  onLaunch: () => void;
  disabled: boolean;
  reason: string | null;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6 sm:py-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <FlaskConical className="h-4 w-4 text-primary" /> Laboratorio
        </h2>
        <p className="text-xs text-muted-foreground">
          Sandbox interno — no envía mensajes reales
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button
          aria-label="Correr evaluación"
          onClick={onLaunch}
          disabled={disabled || running || launching}
          aria-describedby={reason ? "lab-run-reason" : undefined}
        >
          <Play className="h-4 w-4" />
          {running ? "Corrida en curso…" : "Correr evaluación"}
        </Button>
        {reason && (
          <p id="lab-run-reason" className="text-[11px] text-muted-foreground">
            {reason}
          </p>
        )}
      </div>
    </header>
  );
}

function HistoryList({
  runs,
  selectedRunId,
  onSelect,
  onDelete,
}: {
  runs: LabRunSummaryDto[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<string | null>;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Historial
      </p>
      {runs.length === 0 && (
        <p className="text-xs text-muted-foreground">Sin corridas todavía.</p>
      )}
      {runs.map((run) => (
        <HistoryRow
          key={run.id}
          run={run}
          selected={selectedRunId === run.id}
          onSelect={() => onSelect(run.id)}
          onDelete={() => onDelete(run.id)}
        />
      ))}
    </div>
  );
}

/** Fila del historial: seleccionar + eliminar con confirmación en dos pasos. */
function HistoryRow({
  run,
  selected,
  onSelect,
  onDelete,
}: {
  run: LabRunSummaryDto;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delta = deltaView(run);

  async function remove() {
    setBusy(true);
    setError(null);
    const err = await onDelete();
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setConfirming(false);
  }

  return (
    <div
      className={`rounded-lg border transition-colors ${
        // Con tokens planos: `primary/50` no pinta nada (es una var CSS sin canal alfa).
        selected ? "border-brand bg-brand-tint" : "bg-card hover:bg-accent"
      }`}
    >
      <div className="flex items-start">
        <button
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-lg p-3 text-left"
        >
          <div className="flex items-center justify-between gap-2">
            <ScoreBadge run={run} />
            {delta && delta.kind !== "note" && (
              <span
                title={delta.title}
                className={`flex items-center gap-0.5 text-xs font-medium ${
                  delta.kind === "up" ? "text-success" : "text-destructive"
                }`}
              >
                {delta.kind === "up" ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {delta.label}
              </span>
            )}
            {delta?.kind === "note" && (
              <span title={delta.title} className="text-[11px] text-muted-foreground">
                {delta.label}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {new Date(run.startedAt).toLocaleString("es-MX", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {run.personaKeys && ` · ${run.personaKeys.length} persona(s)`}
          </p>
        </button>
        {run.status !== "running" && !confirming && (
          <Button
            variant="ghost"
            size="icon"
            className="m-1.5 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label="Eliminar evaluación"
            title="Eliminar evaluación"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <span className="text-xs text-danger-text">¿Eliminar?</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Eliminando…" : "Sí, eliminar"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </Button>
        </div>
      )}
      {error && (
        <p className="px-3 pb-2 text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ScoreBadge({ run }: { run: Pick<LabRunSummaryDto, "status" | "score"> }) {
  if (run.status === "running") return <Badge variant="secondary">En curso…</Badge>;
  if (run.status === "failed") return <Badge variant="destructive">Fallida</Badge>;
  const score = run.score ?? 0;
  const variant = score >= 80 ? "success" : score >= 50 ? "warning" : "destructive";
  return <Badge variant={variant}>Score {score}</Badge>;
}

function Report({
  detail,
  againstId,
  refreshKey,
  personaName,
  onApplied,
}: {
  detail: { run: RunDetail; cases: LabRunCaseDto[] };
  againstId: string | null;
  refreshKey: number;
  personaName: (key: string) => string;
  onApplied: () => void;
}) {
  const { run, cases } = detail;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Reporte</CardTitle>
            <ScoreBadge run={run} />
          </div>
          {run.status === "failed" && (
            <p className="text-sm text-destructive">
              La corrida falló: {run.error ?? "error desconocido"}. Vuelve a
              intentarlo.
            </p>
          )}
        </CardHeader>
        {run.status === "done" && (
          <CardContent>
            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              {(["verde", "amarillo", "rojo"] as const).map((v) => (
                <div key={v} className="rounded-md border p-3">
                  <p className="text-2xl font-bold">
                    {cases.filter((c) => c.veredicto === v).length}
                  </p>
                  <p className="capitalize text-muted-foreground">{v}s</p>
                </div>
              ))}
            </div>
            {cases.some((c) => c.status === "judge_failed") && (
              <p className="mt-3 text-xs text-warning-text">
                {cases.filter((c) => c.status === "judge_failed").length} caso(s) sin
                veredicto (el juez no respondió válido o la corrida se cortó por
                tiempo); excluidos del score.
              </p>
            )}
          </CardContent>
        )}
      </Card>

      <RunInsights
        runId={run.id}
        againstId={againstId}
        runDone={run.status === "done"}
        refreshKey={refreshKey}
        personaName={personaName}
      />

      {cases.map((c) => (
        <CaseCard key={c.id} testCase={c} onApplied={onApplied} />
      ))}
    </div>
  );
}

function CaseCard({ testCase, onApplied }: { testCase: LabRunCaseDto; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const c = testCase;
  const snap = c.personaSnapshot;
  const ficha = c.fichaCheck ? fichaCheckView(c.fichaCheck as FichaCheck) : null;
  const icon =
    c.veredicto === "verde" ? (
      <CheckCircle2 className="h-4 w-4 text-success" />
    ) : c.veredicto === "amarillo" ? (
      <AlertTriangle className="h-4 w-4 text-warning-text" />
    ) : c.veredicto === "rojo" ? (
      <XCircle className="h-4 w-4 text-destructive" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-muted-foreground" />
    );

  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          className="flex w-full items-center justify-between"
          onClick={() => setOpen(!open)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {c.personaLabel}
            {c.status === "judge_failed" && (
              <Badge variant="secondary">sin veredicto</Badge>
            )}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {ficha && ficha.filas.length > 0 && (
              <Badge variant={ficha.completo ? "success" : "warning"}>{ficha.resumen}</Badge>
            )}
            {c.hallazgos.length > 0 && `${c.hallazgos.length} hallazgo(s)`}
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {snap && (snap.objetivo || snap.criteriosExito) && (
            // La persona TAL COMO corrió (aunque hoy esté editada o archivada).
            <div className="rounded-md border p-3 text-sm">
              {snap.objetivo && (
                <p>
                  <span className="text-muted-foreground">Objetivo:</span> {snap.objetivo}
                </p>
              )}
              {snap.criteriosExito && (
                <p className="mt-1">
                  <span className="text-muted-foreground">Criterios de éxito:</span>{" "}
                  {snap.criteriosExito}
                </p>
              )}
            </div>
          )}
          {c.hallazgos.map((h, i) => (
            <HallazgoCard key={i} hallazgo={h} caseId={c.id} index={i} onApplied={onApplied} />
          ))}
          {ficha && ficha.filas.length > 0 && (
            // Chequeo determinista del llenado: informativo, fuera del score.
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {ficha.resumen} campos esperados
              </p>
              <ul className="space-y-1 text-sm">
                {ficha.filas.map((f) => (
                  <li key={f.key} className="flex items-start gap-2">
                    {f.cumplido ? (
                      <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0 text-success"
                        aria-label="Cumplido"
                      />
                    ) : (
                      <XCircle
                        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                        aria-label="No cumplido"
                      />
                    )}
                    <span className="text-muted-foreground">{f.label}:</span>
                    <span className="min-w-0 break-words">{f.valor}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-md border bg-background/40 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Transcript
            </p>
            <div className="space-y-1.5 text-sm">
              {c.transcript.map((t, i) => (
                <p key={i}>
                  <span
                    className={
                      t.role === "cliente" ? "text-info" : "text-primary"
                    }
                  >
                    {t.role === "cliente" ? "Cliente" : "Agente"}:
                  </span>{" "}
                  {t.text}
                </p>
              ))}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function appliedLabel(a: LabAppliedDto): string {
  if (a.target === "profile") {
    return `Aplicada al perfil${a.field ? ` (${PROFILE_FIELD_LABELS[a.field]})` : ""} ✓`;
  }
  return "Aplicada al conocimiento ✓";
}

/**
 * Hallazgo del juez con sus dos salidas (08, RF-08-12/13): "Agregar al
 * conocimiento" (sugerencia P/R) y "Aplicar al perfil" (ajuste de tono /
 * escalamiento / instrucciones). El estado "Aplicada" viene del servidor
 * (`aplicada`) y es idempotente: un segundo intento responde `alreadyApplied`.
 */
function HallazgoCard({
  hallazgo,
  caseId,
  index,
  onApplied,
}: {
  hallazgo: LabHallazgoDto;
  caseId: string;
  index: number;
  onApplied: () => void;
}) {
  const [mode, setMode] = useState<"kb" | "profile" | null>(null);
  const [pregunta, setPregunta] = useState(hallazgo.sugerencia?.pregunta ?? "");
  const [respuesta, setRespuesta] = useState(hallazgo.sugerencia?.respuesta ?? "");
  const [field, setField] = useState<LabAjusteCampo>(hallazgo.ajuste?.campo ?? "tone");
  const [text, setText] = useState(hallazgo.ajuste?.texto ?? "");
  const [localApplied, setLocalApplied] = useState<LabAppliedDto | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Corridas previas al servidor 08-A no traen `aplicada`.
  const applied = localApplied ?? hallazgo.aplicada ?? null;
  const fieldId = `${caseId}-${index}`;

  function done(result: LabSuggestionApplyResultDto) {
    setLocalApplied(result.application);
    setNote(result.result === "alreadyApplied" ? "Ya estaba aplicada; no se duplicó." : null);
    setMode(null);
    onApplied();
  }

  async function applyKb() {
    setSaving(true);
    setError(null);
    const res = await labFetch<LabSuggestionApplyResultDto>(
      "/api/lab/suggestions/apply",
      {
        method: "POST",
        body: { testCaseId: caseId, hallazgoIndex: index, target: "kb", pregunta, respuesta },
      },
      "No se pudo agregar al conocimiento"
    );
    if (res.ok) {
      setSaving(false);
      done(res.data);
      return;
    }
    if (res.outcome.kind === "not_implemented") {
      // Mientras 08-A no cablea la forma nueva, la vieja sigue viva.
      const legacy = await labFetch<{ entry?: { id?: string } }>(
        "/api/lab/suggestions/apply",
        { method: "POST", body: { caseId, hallazgoIndex: index, pregunta, respuesta } },
        "No se pudo agregar al conocimiento"
      );
      setSaving(false);
      if (legacy.ok) {
        done({
          result: "applied",
          application: {
            target: "kb",
            field: null,
            kbEntryId: legacy.data.entry?.id ?? null,
            appliedText: respuesta,
            appliedAt: new Date().toISOString(),
          },
        });
      } else {
        setError(legacy.outcome.message);
      }
      return;
    }
    setSaving(false);
    setError(res.outcome.message);
  }

  async function applyProfile() {
    setSaving(true);
    setError(null);
    const res = await labFetch<LabSuggestionApplyResultDto>(
      "/api/lab/suggestions/apply",
      {
        method: "POST",
        body: { testCaseId: caseId, hallazgoIndex: index, target: "profile", field, text },
      },
      "No se pudo aplicar al perfil"
    );
    setSaving(false);
    if (res.ok) {
      done(res.data);
      return;
    }
    setError(res.outcome.kind === "too_long" ? tooLongMessage(field) : res.outcome.message);
  }

  return (
    <div className="rounded-md border border-warning-soft bg-warning-tint p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="warning">{TIPO_LABELS[hallazgo.tipo]}</Badge>
        {!applied && !mode && (
          <div className="flex flex-wrap gap-2">
            {hallazgo.sugerencia && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setMode("kb");
                }}
              >
                Agregar al conocimiento
              </Button>
            )}
            {hallazgo.ajuste && (
              <Button
                size="sm"
                variant="outline"
                aria-label="Aplicar al perfil"
                onClick={() => {
                  setError(null);
                  setMode("profile");
                }}
              >
                Aplicar al perfil
              </Button>
            )}
          </div>
        )}
        {applied && (
          <span className="text-xs text-success-text" role="status">
            {appliedLabel(applied)}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Evidencia:</span>{" "}
        {hallazgo.evidencia}
      </p>
      {hallazgo.ajuste && !mode && !applied && (
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            Ajuste sugerido ({PROFILE_FIELD_LABELS[hallazgo.ajuste.campo]}):
          </span>{" "}
          {hallazgo.ajuste.texto}
        </p>
      )}
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}

      {mode === "kb" && hallazgo.sugerencia && (
        <div className="mt-3 space-y-2 rounded-md border bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor={`sug-q-${fieldId}`}>Pregunta</Label>
            <Input
              id={`sug-q-${fieldId}`}
              value={pregunta}
              onChange={(e) => setPregunta(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`sug-a-${fieldId}`}>Respuesta</Label>
            <Textarea
              id={`sug-a-${fieldId}`}
              rows={3}
              value={respuesta}
              onChange={(e) => setRespuesta(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void applyKb()}
              disabled={saving || !pregunta.trim() || !respuesta.trim()}
            >
              {saving ? "Guardando…" : "Guardar en el KB"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setMode(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {mode === "profile" && hallazgo.ajuste && (
        <div className="mt-3 space-y-2 rounded-md border bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor={`aj-f-${fieldId}`}>Campo del perfil</Label>
            <select
              id={`aj-f-${fieldId}`}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={field}
              onChange={(e) => setField(e.target.value as LabAjusteCampo)}
            >
              {LAB_AJUSTE_CAMPOS.map((f) => (
                <option key={f} value={f}>
                  {PROFILE_FIELD_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`aj-t-${fieldId}`}>Texto a agregar</Label>
            <Textarea
              id={`aj-t-${fieldId}`}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Se agrega al final de «{PROFILE_FIELD_LABELS[field]}»; no reemplaza lo que ya
              tiene.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void applyProfile()}
              disabled={saving || !text.trim()}
            >
              {saving ? "Guardando…" : "Guardar en el perfil"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setMode(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
