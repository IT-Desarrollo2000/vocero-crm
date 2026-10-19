import { useId } from "react";
import { CHANNEL_LABEL } from "@/lib/channels";
import {
  CHANNEL_CHART_COLOR,
  buildVolumeSeries,
  dayBarStep,
  dayLabelStep,
  niceScale,
  stackDay,
} from "./chart";
import { formatCount, formatDayLong, formatDayShort } from "./format";
import type { VolumeDto } from "./types";

const HEIGHT = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 36 };

/**
 * M8 — Mensajes por día local, apilados por canal. Una barra por CADA día del
 * rango, también los vacíos (CA-02-04). Con muchos días el gráfico es más
 * ancho que la tarjeta y se desplaza DENTRO de ella: la página nunca gana
 * scroll horizontal en móvil.
 */
export function VolumeChart({
  data,
  days,
}: {
  data: VolumeDto;
  /** Días locales del rango (`range.days` del reporte). */
  days: readonly string[];
}) {
  const titleId = useId();
  const series = buildVolumeSeries(days, data.rows);
  const { max, ticks } = niceScale(series.maxTotal);
  const step = dayBarStep(series.days.length);
  const barWidth = Math.max(2, Math.round(step * 0.7));
  const labelEvery = dayLabelStep(series.days.length);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const width = PAD.left + series.days.length * step + PAD.right;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const total = series.inbound + series.outbound;
  const summary = `Volumen de mensajes por día: ${series.days.length} días, ${formatCount(total)} mensajes (${formatCount(series.inbound)} entrantes, ${formatCount(series.outbound)} salientes)`;

  return (
    <figure className="m-0">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.channels.length === 0 ? (
          <span>Sin mensajes en este rango.</span>
        ) : (
          series.channels.map((c) => (
            <span key={c} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ background: CHANNEL_CHART_COLOR[c] }}
                aria-hidden="true"
              />
              {CHANNEL_LABEL[c]}
            </span>
          ))
        )}
        <span className="ml-auto tabular-nums">
          {formatCount(series.inbound)} entrantes · {formatCount(series.outbound)} salientes
        </span>
      </div>

      <div className="overflow-x-auto pb-1 print:overflow-visible">
        <svg
          role="img"
          aria-labelledby={titleId}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          // En papel no hay scroll: con muchos días el gráfico se encoge al ancho.
          className="block print:h-auto print:max-w-full"
          data-testid="volume-chart"
          data-days={series.days.length}
        >
          <title id={titleId}>{summary}</title>
          {ticks.map((t) => (
            <g key={t} aria-hidden="true">
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                style={{ stroke: "var(--border)" }}
              />
              <text
                x={PAD.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={10}
                style={{ fill: "var(--text-3)" }}
              >
                {formatCount(t)}
              </text>
            </g>
          ))}
          {series.days.map((d, i) => {
            const x = PAD.left + i * step + (step - barWidth) / 2;
            const segments = stackDay(d, series.channels);
            const tooltip = [
              `${formatDayLong(d.day)}: ${formatCount(d.total)} mensajes`,
              ...segments.map((s) => `${s.label}: ${formatCount(s.value)}`),
              `${formatCount(d.inbound)} entrantes · ${formatCount(d.outbound)} salientes`,
            ].join("\n");
            return (
              <g key={d.day} data-testid="volume-day" data-day={d.day}>
                <title>{tooltip}</title>
                {/* Zona de cursor de toda la columna, también en días vacíos. */}
                <rect
                  x={PAD.left + i * step}
                  y={PAD.top}
                  width={step}
                  height={plotH}
                  fill="transparent"
                />
                {segments.map((s) => {
                  const top = y(s.start + s.value);
                  const h = Math.max(1, y(s.start) - top);
                  return (
                    <rect
                      key={s.channel}
                      x={x}
                      y={top}
                      width={barWidth}
                      height={h}
                      style={{ fill: s.color }}
                    />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text
                    x={PAD.left + i * step + step / 2}
                    y={HEIGHT - 6}
                    textAnchor="middle"
                    fontSize={10}
                    aria-hidden="true"
                    style={{ fill: "var(--text-3)" }}
                  >
                    {formatDayShort(d.day)}
                  </text>
                )}
              </g>
            );
          })}
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={PAD.top + plotH}
            y2={PAD.top + plotH}
            strokeWidth={1}
            aria-hidden="true"
            style={{ stroke: "var(--border-strong)" }}
          />
        </svg>
      </div>

      <table className="sr-only">
        <caption>Mensajes por día y canal</caption>
        <thead>
          <tr>
            <th scope="col">Día</th>
            {series.channels.map((c) => (
              <th key={c} scope="col">
                {CHANNEL_LABEL[c]}
              </th>
            ))}
            <th scope="col">Entrantes</th>
            <th scope="col">Salientes</th>
          </tr>
        </thead>
        <tbody>
          {series.days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatDayLong(d.day)}</th>
              {series.channels.map((c) => (
                <td key={c}>{formatCount(d.byChannel[c])}</td>
              ))}
              <td>{formatCount(d.inbound)}</td>
              <td>{formatCount(d.outbound)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
