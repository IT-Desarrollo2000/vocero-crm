"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { LabRunDiffDto, LabTrendsDto } from "@/lib/lab";
import { labFetch } from "./lab-fetch";
import {
  TIPO_LABELS,
  VEREDICTO_LABELS,
  barWidth,
  buildTrendsTable,
  diffUrl,
  summarizeDiff,
  type DiffSummary,
  type TrendCell,
  type TrendsTable,
} from "./lab-logic";

type Tab = "diff" | "trends";

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "unavailable" }
  | { status: "error"; message: string };

/**
 * 08 — "Qué cambió" (contra la corrida anterior comparable) y "Tendencias"
 * (hallazgos por tipo y veredicto por persona entre corridas). `refreshKey`
 * cambia cuando termina una corrida, para no mostrar datos viejos.
 */
export function RunInsights({
  runId,
  againstId,
  runDone,
  refreshKey,
  personaName,
}: {
  runId: string;
  againstId: string | null;
  runDone: boolean;
  refreshKey: number;
  personaName: (key: string) => string;
}) {
  const [tab, setTab] = useState<Tab>("diff");
  const tabs: { id: Tab; label: string }[] = [
    { id: "diff", label: "Qué cambió" },
    { id: "trends", label: "Tendencias" },
  ];

  return (
    <Card>
      <div role="tablist" aria-label="Análisis de corridas" className="flex gap-1 border-b px-4 pt-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`lab-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`lab-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 pb-2 text-sm font-medium ${
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CardContent className="pt-4">
        {tab === "diff" ? (
          <div role="tabpanel" id="lab-panel-diff" aria-label="Qué cambió">
            {runDone ? (
              <DiffPanel runId={runId} againstId={againstId} refreshKey={refreshKey} personaName={personaName} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Disponible cuando la corrida termine.
              </p>
            )}
          </div>
        ) : (
          <div role="tabpanel" id="lab-panel-trends" aria-label="Tendencias">
            <TrendsPanel refreshKey={refreshKey} personaName={personaName} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function useLoad<T>(url: string, refreshKey: number): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    void labFetch<T>(url, undefined, "No se pudo cargar").then((res) => {
      if (!alive) return;
      if (res.ok) setState({ status: "ready", data: res.data });
      else if (res.outcome.kind === "not_implemented") setState({ status: "unavailable" });
      else setState({ status: "error", message: res.outcome.message });
    });
    return () => {
      alive = false;
    };
  }, [url, refreshKey]);
  return state;
}

function LoadState({ state }: { state: Load<unknown> }) {
  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }
  if (state.status === "unavailable") {
    return <p className="text-sm text-muted-foreground">Disponible pronto.</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-danger-text" role="alert">
        {state.message}
      </p>
    );
  }
  return null;
}

function DiffPanel({
  runId,
  againstId,
  refreshKey,
  personaName,
}: {
  runId: string;
  againstId: string | null;
  refreshKey: number;
  personaName: (key: string) => string;
}) {
  const state = useLoad<LabRunDiffDto>(diffUrl(runId, againstId), refreshKey);
  if (state.status !== "ready") return <LoadState state={state} />;
  return <DiffView summary={summarizeDiff(state.data)} personaName={personaName} />;
}

function Before({ before, after }: { before: string | null; after: string | null }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="rounded-md border p-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Antes</p>
        <p className="whitespace-pre-wrap break-words text-sm">{before || "(vacío)"}</p>
      </div>
      <div className="rounded-md border border-brand-soft bg-brand-tint p-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Después</p>
        <p className="whitespace-pre-wrap break-words text-sm">{after || "(vacío)"}</p>
      </div>
    </div>
  );
}

function DiffView({
  summary: s,
  personaName,
}: {
  summary: DiffSummary;
  personaName: (key: string) => string;
}) {
  if (!s.available) return <p className="text-sm text-muted-foreground">{s.message}</p>;
  if (s.empty) {
    return (
      <p className="text-sm text-muted-foreground">
        Sin cambios de configuración contra la corrida anterior.
      </p>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <ul className="flex flex-wrap gap-2" aria-label="Resumen de cambios">
        {s.headline.map((h) => (
          <li key={h} className="rounded-full border bg-secondary px-2.5 py-0.5 text-xs">
            {h}
          </li>
        ))}
      </ul>

      {s.profile.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Perfil del agente
          </h4>
          {s.profile.map((p) => (
            <div key={p.field} className="space-y-1">
              <p className="font-medium">{p.label}</p>
              <Before before={p.before} after={p.after} />
            </div>
          ))}
        </section>
      )}

      {(s.kb.added.length > 0 || s.kb.removed.length > 0 || s.kb.edited.length > 0) && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Conocimiento
          </h4>
          <ul className="space-y-1">
            {s.kb.added.map((t, i) => (
              <li key={`a${i}`} className="text-success-text">
                + {t}
              </li>
            ))}
            {s.kb.removed.map((t, i) => (
              <li key={`r${i}`} className="text-danger-text">
                − {t}
              </li>
            ))}
            {s.kb.edited.map((e, i) => (
              <li key={`e${i}`} className="text-warning-text">
                ~ {e.after}
                {e.before !== e.after && (
                  <span className="text-muted-foreground"> (antes: {e.before})</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(s.personas.added.length > 0 ||
        s.personas.removed.length > 0 ||
        s.personas.edited.length > 0) && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Personas
          </h4>
          <ul className="space-y-1">
            {s.personas.added.map((k) => (
              <li key={`a${k}`} className="text-success-text">
                + {personaName(k)}
              </li>
            ))}
            {s.personas.removed.map((k) => (
              <li key={`r${k}`} className="text-danger-text">
                − {personaName(k)}
              </li>
            ))}
            {s.personas.edited.map((k) => (
              <li key={`e${k}`} className="text-warning-text">
                ~ {personaName(k)} (guion o criterios editados)
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.models.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Modelos
          </h4>
          {s.models.map((m) => (
            <p key={m.label}>
              {m.label}: <span className="text-muted-foreground">{m.before ?? "—"}</span> →{" "}
              {m.after ?? "—"}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

function TrendsPanel({
  refreshKey,
  personaName,
}: {
  refreshKey: number;
  personaName: (key: string) => string;
}) {
  const state = useLoad<LabTrendsDto>("/api/lab/trends", refreshKey);
  if (state.status !== "ready") return <LoadState state={state} />;
  const table = buildTrendsTable(state.data);
  if (table.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay corridas terminadas para ver tendencias.
      </p>
    );
  }
  return <TrendsView table={table} personaName={personaName} />;
}

const VEREDICTO_DOT: Record<Exclude<TrendCell, null>, string> = {
  verde: "bg-success",
  amarillo: "bg-warning",
  rojo: "bg-destructive",
  sin_veredicto: "border border-border-strong",
};

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TrendsView({
  table,
  personaName,
}: {
  table: TrendsTable;
  personaName: (key: string) => string;
}) {
  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-2 text-left text-xs text-muted-foreground">
            Hallazgos por tipo en cada corrida (la más reciente arriba)
          </caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">
                Corrida
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Score
              </th>
              {table.tipos.map((t) => (
                <th key={t} scope="col" className="py-1 pr-3 font-medium">
                  {TIPO_LABELS[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.id} className="border-t">
                <th scope="row" className="py-1.5 pr-3 text-left text-xs font-normal">
                  {dateLabel(r.startedAt)}
                </th>
                <td className="py-1.5 pr-3">{r.score ?? "—"}</td>
                {table.tipos.map((t) => (
                  <td key={t} className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <svg width="64" height="8" aria-hidden="true" className="shrink-0">
                        <rect width="64" height="8" rx="2" className="fill-secondary" />
                        <rect
                          width={(barWidth(r.counts[t], table.maxCount) / 100) * 64}
                          height="8"
                          rx="2"
                          className="fill-warning"
                        />
                      </svg>
                      <span className="tabular-nums">{r.counts[t]}</span>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {table.personaKeys.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="mb-2 text-left text-xs text-muted-foreground">
              Veredicto por persona en cada corrida
            </caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Corrida
                </th>
                {table.personaKeys.map((k) => (
                  <th key={k} scope="col" className="py-1 pr-3 font-medium">
                    {personaName(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <th scope="row" className="py-1.5 pr-3 text-left text-xs font-normal">
                    {dateLabel(r.startedAt)}
                  </th>
                  {table.personaKeys.map((k) => {
                    const v = r.veredictos[k] ?? null;
                    return (
                      <td key={k} className="py-1.5 pr-3">
                        {v ? (
                          <span className="flex items-center gap-1.5 text-xs">
                            <span
                              aria-hidden="true"
                              className={`inline-block h-2.5 w-2.5 rounded-full ${VEREDICTO_DOT[v]}`}
                            />
                            {VEREDICTO_LABELS[v]}
                          </span>
                        ) : (
                          <span className="text-xs text-text-4" title="No participó">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
