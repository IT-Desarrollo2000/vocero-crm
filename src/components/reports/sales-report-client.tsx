"use client";

import { useId } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox } from "lucide-react";
import { formatMoneyCents } from "@/lib/money";
import type {
  ReportBlock,
  SalesAdvisorRowDto,
  SalesByDayDto,
  SalesFunnelDto,
  SalesLossReasonsDto,
  SalesReportDto,
  SalesSummaryDto,
  SalesTimeToCloseDto,
} from "@/lib/reports";
import { formatWonAmount, wonAmountNote } from "./ads-report-format";
import { barPercent, dayLabelStep, niceScale } from "./chart";
import {
  EMPTY_VALUE,
  formatCount,
  formatDayLong,
  formatDayShort,
  formatPercent,
  ratio,
} from "./format";
import { KpiTile } from "./kpi-tile";
import { ReportSection } from "./report-section";
import {
  SALES_BLOCKS,
  compareDetail,
  formatDays,
  formatTicket,
  isSalesReportEmpty,
  salesCaveats,
  salesDayGeometry,
} from "./sales-report-format";
import { useBlocksReport } from "./use-blocks-report";

/**
 * 021 — Reportes → Ventas. Pide `GET /api/reports/sales` con el rango de la
 * URL y pinta cada bloque por su cuenta. Una venta cuenta el día en que el
 * lead pasó a Ganado (D1) y se atribuye a quien lo movió (D2).
 */
export function SalesReportClient() {
  const { report, range, loading, picker, failureNotice } = useBlocksReport<SalesReportDto>(
    "sales",
    SALES_BLOCKS
  );
  const empty = report ? isSalesReportEmpty(report) : false;
  const showBlocks = loading || !!report;
  const summary = report?.summary.ok ? report.summary.data : null;
  const sinMonto = summary?.wonAmount.wonWithoutAmount ?? 0;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 print:space-y-4 print:p-0">
      {picker}
      {failureNotice}

      {!loading && empty && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border bg-subtle px-4 py-3 text-sm text-muted-foreground"
        >
          <Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />
          No se ganó ni se perdió ningún lead en este rango.
        </p>
      )}

      {!loading && sinMonto > 0 && (
        <p
          role="status"
          data-testid="sales-without-amount"
          className="flex items-center gap-2 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3 text-sm text-warning-text"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {sinMonto === 1 ? "1 venta" : `${formatCount(sinMonto)} ventas`} del rango sin
            monto: captúralo en{" "}
            <Link href="/pipeline" className="font-medium underline underline-offset-2">
              Seguimiento
            </Link>{" "}
            para que sume.
          </span>
        </p>
      )}

      {showBlocks && (
        <>
          <Kpis block={report?.summary} loading={loading} />

          <ReportSection
            title="Ventas por día"
            description="Ventas ganadas cada día, en la zona horaria del negocio."
            block={report?.byDay}
            loading={loading}
          >
            {(data) => <SalesDayChart data={data} />}
          </ReportSection>

          <ReportSection
            title="Por asesor"
            description="Quién movió el lead a Ganado o Perdido; si lo movió el asistente, el asesor asignado a la conversación."
            block={report?.byAdvisor}
            loading={loading}
          >
            {(data) => <AdvisorTable rows={data.rows} />}
          </ReportSection>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <ReportSection
              title="Perdidas por motivo"
              description="Motivo registrado al marcar el lead como Perdido."
              block={report?.lossReasons}
              loading={loading}
            >
              {(data) => <LossReasons data={data} />}
            </ReportSection>

            <ReportSection
              title="Tiempo de cierre"
              description="Desde que llegó el lead (su primer anuncio, o su alta) hasta que se ganó."
              block={report?.timeToClose}
              loading={loading}
            >
              {(data) => <TimeToClose data={data} />}
            </ReportSection>
          </div>

          <ReportSection
            title="Embudo actual"
            description="Estado al momento de generar el reporte, no depende del rango."
            block={report?.funnel}
            loading={loading}
          >
            {(data) => <Funnel data={data} />}
          </ReportSection>

          {range && <HowCounted summary={summary} tz={range.tz} />}
        </>
      )}
    </div>
  );
}

function Kpis({
  block,
  loading,
}: {
  block: ReportBlock<SalesSummaryDto> | undefined;
  loading: boolean;
}) {
  const d = block?.ok ? block.data : null;
  const prev = d?.previous ?? null;
  const unavailable = !loading && !d;
  const note = d ? wonAmountNote(d.wonAmount) : null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5 print:grid-cols-3"
      role="group"
      aria-label="Resumen de ventas"
    >
      <KpiTile
        label="Ventas ganadas"
        testId="kpi-sales-won"
        value={d ? formatCount(d.won) : "—"}
        detail={d ? compareDetail(d.won, prev?.won, prev) : undefined}
        help="Leads que hoy están en Ganado y se ganaron en el rango."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Monto ganado"
        testId="kpi-sales-amount"
        value={d ? formatWonAmount(d.wonAmount) : "—"}
        detail={
          d
            ? (note ??
              compareDetail(d.wonAmount.amountCents, prev?.wonAmount.amountCents, prev))
            : undefined
        }
        help="Suma de los montos de las ventas en la moneda del negocio. Otras monedas van aparte, nunca sumadas; una venta sin monto cuenta como venta pero no suma."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Ticket promedio"
        testId="kpi-sales-ticket"
        value={d ? formatTicket(d.averageTicketCents, d.wonAmount.currency) : "—"}
        help="Monto ganado entre las ventas que tienen monto en la moneda del negocio."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Tasa de cierre"
        testId="kpi-sales-close-rate"
        value={d ? formatPercent(d.closeRate) : "—"}
        detail={
          d && d.won + d.lost > 0
            ? `${formatCount(d.won)} de ${formatCount(d.won + d.lost)} cierres`
            : undefined
        }
        help="Ganadas entre ganadas más perdidas del rango."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Perdidas"
        testId="kpi-sales-lost"
        value={d ? formatCount(d.lost) : "—"}
        detail={d ? compareDetail(d.lost, prev?.lost, prev) : undefined}
        help="Leads que hoy están en Perdido y se perdieron en el rango."
        loading={loading}
        unavailable={unavailable}
      />
    </div>
  );
}

const CHART_H = 160;
const CHART_PAD = { top: 8, right: 8, bottom: 22, left: 30 };

/** Barras de ventas por día, al estilo del volumen de Agente. */
function SalesDayChart({ data }: { data: SalesByDayDto }) {
  const titleId = useId();
  const rows = data.rows;
  const total = rows.reduce((a, r) => a + r.won, 0);
  const amount = rows.reduce((a, r) => a + r.amountCents, 0);
  const { max, ticks } = niceScale(Math.max(0, ...rows.map((r) => r.won)));
  const { step, barWidth, plotWidth } = salesDayGeometry(rows.length);
  const labelEvery = dayLabelStep(rows.length);
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
  const width = CHART_PAD.left + plotWidth + CHART_PAD.right;
  const y = (v: number) => CHART_PAD.top + plotH - (v / max) * plotH;
  const money = (c: number) => formatMoneyCents(c, data.currency) ?? EMPTY_VALUE;

  return (
    <figure className="m-0">
      <p className="mb-3 text-right text-xs tabular-nums text-muted-foreground">
        {total === 1 ? "1 venta" : `${formatCount(total)} ventas`} · {money(amount)}
      </p>
      <div className="overflow-x-auto pb-1 print:overflow-visible">
        <svg
          role="img"
          aria-labelledby={titleId}
          width={width}
          height={CHART_H}
          viewBox={`0 0 ${width} ${CHART_H}`}
          className="block print:h-auto print:max-w-full"
          data-testid="sales-day-chart"
          data-days={rows.length}
        >
          <title id={titleId}>
            {`Ventas por día: ${rows.length} días, ${formatCount(total)} ventas`}
          </title>
          {ticks.map((t) => (
            <g key={t} aria-hidden="true">
              <line
                x1={CHART_PAD.left}
                x2={width - CHART_PAD.right}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                style={{ stroke: "var(--border)" }}
              />
              <text
                x={CHART_PAD.left - 6}
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
          {rows.map((r, i) => {
            const x = CHART_PAD.left + i * step + (step - barWidth) / 2;
            const top = y(r.won);
            return (
              <g key={r.day} data-day={r.day}>
                <title>{`${formatDayLong(r.day)}: ${formatCount(r.won)} ventas · ${money(r.amountCents)}`}</title>
                <rect
                  x={CHART_PAD.left + i * step}
                  y={CHART_PAD.top}
                  width={step}
                  height={plotH}
                  fill="transparent"
                />
                {r.won > 0 && (
                  <rect
                    x={x}
                    y={top}
                    width={barWidth}
                    height={Math.max(1, CHART_PAD.top + plotH - top)}
                    rx={2}
                    style={{ fill: "var(--accent)" }}
                  />
                )}
                {i % labelEvery === 0 && (
                  <text
                    x={CHART_PAD.left + i * step + step / 2}
                    y={CHART_H - 6}
                    textAnchor="middle"
                    fontSize={10}
                    aria-hidden="true"
                    style={{ fill: "var(--text-3)" }}
                  >
                    {formatDayShort(r.day)}
                  </text>
                )}
              </g>
            );
          })}
          <line
            x1={CHART_PAD.left}
            x2={width - CHART_PAD.right}
            y1={CHART_PAD.top + plotH}
            y2={CHART_PAD.top + plotH}
            strokeWidth={1}
            aria-hidden="true"
            style={{ stroke: "var(--border-strong)" }}
          />
        </svg>
      </div>
      <table className="sr-only">
        <caption>Ventas por día</caption>
        <thead>
          <tr>
            <th scope="col">Día</th>
            <th scope="col">Ventas</th>
            <th scope="col">Monto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <th scope="row">{formatDayLong(r.day)}</th>
              <td>{formatCount(r.won)}</td>
              <td>{money(r.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function AmountCell({ row }: { row: SalesAdvisorRowDto }) {
  const note = wonAmountNote(row.wonAmount);
  return (
    <>
      <span className="block font-medium tabular-nums">
        {row.won === 0 ? EMPTY_VALUE : formatWonAmount(row.wonAmount)}
      </span>
      {note && <span className="block text-[11px] text-warning-text">{note}</span>}
    </>
  );
}

function AdvisorTable({ rows }: { rows: SalesAdvisorRowDto[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin cierres en este rango.</p>;
  }
  return (
    <>
      {/* Móvil: una tarjeta por asesor. */}
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Ventas por asesor">
        {rows.map((r) => (
          <li key={r.userId ?? "none"} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.userId ? "" : "text-text-3"}`}>{r.name}</p>
            <dl className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
              <MobileStat label="Ganadas" value={formatCount(r.won)} />
              <MobileStat label="Perdidas" value={formatCount(r.lost)} />
              <MobileStat label="Cierre" value={formatPercent(r.closeRate)} />
              <MobileStat
                label="Monto"
                value={r.won === 0 ? EMPTY_VALUE : formatWonAmount(r.wonAmount)}
              />
            </dl>
            {wonAmountNote(r.wonAmount) && (
              <p className="mt-1 text-[11px] text-warning-text">{wonAmountNote(r.wonAmount)}</p>
            )}
          </li>
        ))}
      </ul>

      {/* Escritorio (y papel): tabla. */}
      <table className="hidden w-full text-sm sm:table print:table" aria-label="Ventas por asesor">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Asesor</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Ganadas</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Perdidas</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Cierre</th>
            <th scope="col" className="pb-2 text-right font-medium">Monto ganado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.userId ?? "none"}
              data-advisor={r.userId ?? "none"}
              className={`border-t align-top ${r.userId ? "" : "text-text-3"}`}
            >
              <th scope="row" className="py-2.5 pr-3 text-left font-medium">{r.name}</th>
              <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{formatCount(r.won)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(r.lost)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{formatPercent(r.closeRate)}</td>
              <td className="py-2.5 text-right">
                <AmountCell row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-3">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function LossReasons({ data }: { data: SalesLossReasonsDto }) {
  if (data.total === 0) {
    return <p className="text-sm text-muted-foreground">No se perdió ningún lead en este rango.</p>;
  }
  const max = data.rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <table className="w-full text-sm" aria-label="Perdidas por motivo">
      <tbody>
        {data.rows.map((r) => (
          <tr key={r.reason} className="border-t first:border-t-0 align-top">
            <th scope="row" className="py-2.5 pr-3 text-left font-normal">
              <span className="block font-medium">{r.label}</span>
              <span
                className="mt-1.5 block h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-secondary"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${barPercent(r.count, max)}%`, background: "var(--danger)" }}
                />
              </span>
            </th>
            <td className="w-12 py-2.5 pr-2 text-right font-semibold tabular-nums">
              {formatCount(r.count)}
            </td>
            <td className="w-14 py-2.5 text-right text-xs text-muted-foreground tabular-nums">
              {formatPercent(ratio(r.count, data.total))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimeToClose({ data }: { data: SalesTimeToCloseDto }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-md border bg-subtle p-3">
          <dt className="text-xs text-muted-foreground">Mediana</dt>
          <dd className="mt-0.5 text-xl font-semibold tabular-nums" data-testid="close-p50">
            {formatDays(data.p50Days)}
          </dd>
        </div>
        <div className="rounded-md border bg-subtle p-3">
          <dt className="text-xs text-muted-foreground">3 de cada 4 cierran en</dt>
          <dd className="mt-0.5 text-xl font-semibold tabular-nums">{formatDays(data.p75Days)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        {data.sales === 1 ? "1 venta medida" : `${formatCount(data.sales)} ventas medidas`}
        {data.excludedApproximate > 0
          ? ` · ${formatCount(data.excludedApproximate)} con fecha aproximada fuera de la medición`
          : ""}
        .
      </p>
    </div>
  );
}

function Funnel({ data }: { data: SalesFunnelDto }) {
  const money = (c: number) => formatMoneyCents(c, data.currency) ?? EMPTY_VALUE;
  const max = data.stages.reduce((m, s) => Math.max(m, s.leads), 0);
  if (data.stages.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay etapas configuradas.</p>;
  }
  return (
    <div className="space-y-2">
      <table className="w-full text-sm" aria-label="Embudo actual">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Etapa</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Leads</th>
            <th scope="col" className="pb-2 text-right font-medium">Monto</th>
          </tr>
        </thead>
        <tbody>
          {data.stages.map((s) => {
            const notes = [
              s.leadsWithoutAmount > 0 ? `${formatCount(s.leadsWithoutAmount)} sin monto` : null,
              s.leadsOtherCurrency > 0
                ? `${formatCount(s.leadsOtherCurrency)} en otra moneda`
                : null,
            ].filter(Boolean);
            return (
              <tr key={s.stageId} data-stage={s.kind} className="border-t align-top">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  <span className="block font-medium">
                    {s.name}
                    {s.kind !== "open" && (
                      <span className="ml-1.5 text-xs font-normal text-text-3">
                        ({s.kind === "won" ? "ganado" : "perdido"})
                      </span>
                    )}
                  </span>
                  <span
                    className="mt-1.5 block h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-secondary"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${barPercent(s.leads, max)}%`,
                        background:
                          s.kind === "won"
                            ? "var(--success)"
                            : s.kind === "lost"
                              ? "var(--danger)"
                              : "var(--accent)",
                      }}
                    />
                  </span>
                </th>
                <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                  {formatCount(s.leads)}
                </td>
                <td className="py-2.5 text-right">
                  <span className="block tabular-nums">{money(s.amountCents)}</span>
                  {notes.length > 0 && (
                    <span className="block text-[11px] text-text-3">{notes.join(" · ")}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t font-semibold">
            <th scope="row" className="py-2.5 pr-3 text-left">Total</th>
            <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(data.totalLeads)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function HowCounted({ summary, tz }: { summary: SalesSummaryDto | null; tz: string }) {
  const caveats = summary ? salesCaveats(summary) : [];
  return (
    <section
      aria-label="Cómo se cuenta"
      className="rounded-lg border bg-subtle p-4 text-xs text-text-2 print:break-inside-avoid sm:p-5"
      data-testid="sales-how-counted"
    >
      <h3 className="mb-2 text-sm font-semibold text-foreground">Cómo se cuenta</h3>
      <ul className="list-disc space-y-1 pl-4">
        <li>
          Una venta es un lead que hoy está en Ganado, contada el día en que se ganó. Si después
          se reabre o se pierde, deja de contar: por eso el reporte de un periodo pasado puede
          cambiar.
        </li>
        <li>
          Una perdida es un lead que hoy está en Perdido, contada el día en que se perdió, con el
          motivo que se registró en ese momento.
        </li>
        <li>
          El asesor es quien movió el lead a Ganado (o a Perdido). Si lo movió el asistente, se
          atribuye al asesor asignado a la conversación; si no hay, «Sin asesor».
        </li>
        <li>Los montos nunca suman monedas distintas. Excluye el Laboratorio. Días en {tz}.</li>
        {caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </section>
  );
}
