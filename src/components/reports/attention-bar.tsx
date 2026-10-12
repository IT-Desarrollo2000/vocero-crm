import { attentionSegments } from "./chart";
import { formatCount, formatPercent } from "./format";
import type { AttentionDto } from "./types";

/**
 * M2 — Reparto de atención de las conversaciones activas, en una barra
 * apilada al 100 %. La leyenda repite cifra y porcentaje (el color nunca va
 * solo) y la tabla oculta es la versión para lector de pantalla.
 */
export function AttentionBar({ data }: { data: AttentionDto }) {
  const segments = attentionSegments(data);
  const summary =
    data.active > 0
      ? segments
          .map((s) => `${s.label} ${formatCount(s.count)} (${formatPercent(s.share)})`)
          .join(", ")
      : "sin conversaciones activas";

  return (
    <figure className="m-0">
      <div
        role="img"
        aria-label={`Reparto de atención de ${formatCount(data.active)} conversaciones activas: ${summary}`}
        className="flex h-4 w-full overflow-hidden rounded-full bg-secondary"
      >
        {data.active > 0 &&
          segments.map((s) =>
            s.count > 0 ? (
              <div
                key={s.key}
                title={`${s.label}: ${formatCount(s.count)} (${formatPercent(s.share)})`}
                className="h-full border-r-2 border-card last:border-r-0"
                style={{ width: `${(s.share ?? 0) * 100}%`, background: s.color }}
              />
            ) : null
          )}
      </div>
      <figcaption className="mt-3">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" aria-hidden="true">
          {segments.map((s) => (
            <li key={s.key} className="flex min-w-0 items-start gap-2">
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs text-muted-foreground">
                  {s.label}
                </span>
                <span className="font-medium tabular-nums">
                  {formatCount(s.count)}
                </span>{" "}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatPercent(s.share)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
      <table className="sr-only">
        <caption>Reparto de atención de las conversaciones activas</caption>
        <thead>
          <tr>
            <th scope="col">Atención</th>
            <th scope="col">Conversaciones</th>
            <th scope="col">Porcentaje</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td>{formatCount(s.count)}</td>
              <td>{formatPercent(s.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
