import { useId } from "react";
import { barPercent } from "./chart";
import { formatCount, formatDuration } from "./format";
import type { AfterHandoffDto, ResponseTimesDto } from "./types";

type Row = {
  key: string;
  label: string;
  sessions: number;
  p50: number | null;
  p90: number | null;
  color: string;
};

/**
 * M4 (y M5 si llega) — Tiempo a primera respuesta, IA contra humano. Cada
 * fila es una barra de p90 (tenue, de fondo) con la mediana encima (sólida):
 * la distancia entre ambas cuenta cuán dispareja es la espera. Escala común
 * para que IA y humano se comparen a simple vista.
 */
export function ResponseTimes({
  data,
  afterHandoff,
}: {
  data: ResponseTimesDto;
  afterHandoff?: AfterHandoffDto | null;
}) {
  const titleId = useId();
  const rows: Row[] = [
    {
      key: "ai",
      label: "IA",
      sessions: data.ai.sessions,
      p50: data.ai.p50Seconds,
      p90: data.ai.p90Seconds,
      color: "var(--success)",
    },
    {
      key: "human",
      label: "Humano",
      sessions: data.human.sessions,
      p50: data.human.p50Seconds,
      p90: data.human.p90Seconds,
      color: "var(--warning)",
    },
  ];
  const max = rows.reduce((m, r) => Math.max(m, r.p90 ?? 0, r.p50 ?? 0), 0);

  return (
    <div className="space-y-4">
      <figure className="m-0">
        <figcaption id={titleId} className="sr-only">
          Tiempo a primera respuesta, mediana y percentil 90, IA contra humano
        </figcaption>
        <div className="space-y-3" role="img" aria-labelledby={titleId} aria-describedby={`${titleId}-t`}>
          {rows.map((r) => (
            <div key={r.key} aria-hidden="true">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  mediana{" "}
                  <span className="font-semibold text-foreground">{formatDuration(r.p50)}</span>{" "}
                  · p90 <span className="font-semibold text-foreground">{formatDuration(r.p90)}</span>{" "}
                  · {formatCount(r.sessions)} sesiones
                </span>
              </div>
              <svg
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
                className="block h-3 w-full overflow-visible rounded-full"
              >
                <rect x="0" y="0" width="100" height="10" rx="5" style={{ fill: "var(--bg-panel)" }} />
                {r.p90 !== null && (
                  <rect
                    x="0"
                    y="0"
                    width={barPercent(r.p90, max)}
                    height="10"
                    rx="5"
                    fillOpacity={0.35}
                    style={{ fill: r.color }}
                  >
                    <title>{`${r.label} p90: ${formatDuration(r.p90)}`}</title>
                  </rect>
                )}
                {r.p50 !== null && (
                  <rect
                    x="0"
                    y="0"
                    width={barPercent(r.p50, max)}
                    height="10"
                    rx="5"
                    style={{ fill: r.color }}
                  >
                    <title>{`${r.label} mediana: ${formatDuration(r.p50)}`}</title>
                  </rect>
                )}
              </svg>
            </div>
          ))}
        </div>
        <table id={`${titleId}-t`} className="sr-only">
          <caption>Tiempo a primera respuesta por quién respondió</caption>
          <thead>
            <tr>
              <th scope="col">Quién respondió</th>
              <th scope="col">Mediana</th>
              <th scope="col">Percentil 90</th>
              <th scope="col">Sesiones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{formatDuration(r.p50)}</td>
                <td>{formatDuration(r.p90)}</td>
                <td>{formatCount(r.sessions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2 w-4 rounded-sm" style={{ background: "var(--text-3)" }} />
          Mediana
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2 w-4 rounded-sm opacity-40" style={{ background: "var(--text-3)" }} />
          p90 (9 de cada 10 esperan menos)
        </span>
        <span data-testid="unanswered-sessions">
          Sesiones sin respuesta:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {formatCount(data.unanswered)}
          </span>
        </span>
      </div>

      {afterHandoff && (
        <p className="border-t pt-3 text-sm" data-testid="after-handoff">
          <span className="font-medium">Humano tras escalamiento:</span>{" "}
          <span className="text-muted-foreground">
            mediana{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {formatDuration(afterHandoff.p50Seconds)}
            </span>{" "}
            · p90{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {formatDuration(afterHandoff.p90Seconds)}
            </span>{" "}
            · {formatCount(afterHandoff.attended)} atendidos ·{" "}
            {formatCount(afterHandoff.unattended)} sin atender
          </span>
        </p>
      )}
    </div>
  );
}
