"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Inbox } from "lucide-react";
import { CHANNEL_LABEL } from "@/lib/channels";
import type {
  ReportBlock,
  ReportRangeDto,
  SalesSummaryDto,
  SummaryAdFiguresDto,
  SummaryAttentionDto,
  SummaryByAdDto,
  SummaryByChannelDto,
  SummaryByHourDto,
  SummaryPendingDto,
  SummaryReportDto,
} from "@/lib/reports";
import { formatWonAmount, wonAmountNote } from "./ads-report-format";
import { barPercent } from "./chart";
import { EMPTY_VALUE, formatCount, formatDateTime, formatPercent, ratio } from "./format";
import { KpiTile } from "./kpi-tile";
import { ReportSection } from "./report-section";
import { compareDetail } from "./sales-report-format";
import {
  SUMMARY_BLOCKS,
  adRowLabels,
  adTotals,
  currentHourIfToday,
  isSummaryReportEmpty,
  rateDetail,
  summaryHighlights,
} from "./summary-report-format";
import { useBlocksReport } from "./use-blocks-report";

/**
 * 021 — Reportes → Resumen para dirección: la pestaña que se imprime para
 * los superiores. Cifras grandes arriba, una lectura rápida en frases y las
 * tablas que la sostienen. Unidad = persona (conversación real con al menos
 * un mensaje recibido en el rango).
 */
export function SummaryReportClient() {
  const { report, range, loading, picker, failureNotice } = useBlocksReport<SummaryReportDto>(
    "summary",
    SUMMARY_BLOCKS
  );
  const empty = report ? isSummaryReportEmpty(report) : false;
  const showBlocks = loading || !!report;

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
          Nadie escribió en este rango.
        </p>
      )}

      {showBlocks && (
        <>
          <Kpis attention={report?.attention} sales={report?.sales} loading={loading} />

          {report && <Highlights report={report} />}

          <ReportSection
            title="Por anuncio"
            description="Personas agrupadas por el primer anuncio que las trajo."
            block={report?.byAd}
            loading={loading}
          >
            {(data) => <ByAdTable data={data} report={report} />}
          </ReportSection>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2 print:grid-cols-1">
            <ReportSection
              title="Por canal"
              block={report?.byChannel}
              loading={loading}
            >
              {(data) => <ByChannelTable data={data} />}
            </ReportSection>

            <ReportSection
              title="Mensajes recibidos por hora"
              description="Sumando todos los días del rango, en la hora del negocio."
              block={report?.byHour}
              loading={loading}
            >
              {(data) => <ByHourBars data={data} range={range} />}
            </ReportSection>
          </div>

          <ReportSection
            title="Pendientes de respuesta"
            description="Personas cuyo último mensaje es suyo y nadie le ha respondido, al momento de generar el reporte."
            block={report?.pending}
            loading={loading}
          >
            {(data) => <PendingList data={data} tz={range?.tz ?? "UTC"} />}
          </ReportSection>

          {range && <HowCounted tz={range.tz} />}
        </>
      )}
    </div>
  );
}

function Kpis({
  attention,
  sales,
  loading,
}: {
  attention: ReportBlock<SummaryAttentionDto> | undefined;
  sales: ReportBlock<SalesSummaryDto> | undefined;
  loading: boolean;
}) {
  const a = attention?.ok ? attention.data : null;
  const ap = a?.previous ?? null;
  const s = sales?.ok ? sales.data : null;
  const sp = s?.previous ?? null;
  const aUnavailable = !loading && !a;
  const sUnavailable = !loading && !s;
  const newDetail = a
    ? [
        `${formatCount(a.newPersons)} ${a.newPersons === 1 ? "nueva" : "nuevas"}`,
        compareDetail(a.persons, ap?.persons, ap),
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const amountNote = s ? wonAmountNote(s.wonAmount) : null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 print:grid-cols-3"
      role="group"
      aria-label="Resumen para dirección"
    >
      <KpiTile
        label="Mensajes recibidos"
        testId="kpi-summary-inbound"
        value={a ? formatCount(a.inbound) : "—"}
        detail={a ? compareDetail(a.inbound, ap?.inbound, ap) : undefined}
        help="Mensajes que escribieron los clientes en el rango (sin el Laboratorio)."
        loading={loading}
        unavailable={aUnavailable}
      />
      <KpiTile
        label="Personas que escribieron"
        testId="kpi-summary-persons"
        value={a ? formatCount(a.persons) : "—"}
        detail={newDetail}
        help="Conversaciones con al menos un mensaje recibido en el rango. Nuevas = contactos que se crearon en el rango."
        loading={loading}
        unavailable={aUnavailable}
      />
      <KpiTile
        label="Contestadas"
        testId="kpi-summary-answered"
        value={a ? formatPercent(a.answeredRate) : "—"}
        detail={a ? rateDetail(a.answered, a.persons, ap?.answeredRate) : undefined}
        help="Personas que recibieron cualquier respuesta (IA, asesor o plantilla) después de su primer mensaje del rango."
        loading={loading}
        unavailable={aUnavailable}
      />
      <KpiTile
        label="Atendidas por un asesor"
        testId="kpi-summary-attended"
        value={a ? formatPercent(a.attendedByAdvisorRate) : "—"}
        detail={
          a ? rateDetail(a.attendedByAdvisor, a.persons, ap?.attendedByAdvisorRate) : undefined
        }
        help="Personas a las que una persona del equipo les respondió después de su primer mensaje del rango."
        loading={loading}
        unavailable={aUnavailable}
      />
      <KpiTile
        label="Ventas ganadas"
        testId="kpi-summary-won"
        value={s ? formatCount(s.won) : "—"}
        detail={s ? compareDetail(s.won, sp?.won, sp) : undefined}
        help="Leads que hoy están en Ganado y se ganaron en el rango (igual que la pestaña Ventas)."
        loading={loading}
        unavailable={sUnavailable}
      />
      <KpiTile
        label="Monto ganado"
        testId="kpi-summary-amount"
        value={s ? formatWonAmount(s.wonAmount) : "—"}
        detail={
          s
            ? (amountNote ??
              compareDetail(s.wonAmount.amountCents, sp?.wonAmount.amountCents, sp))
            : undefined
        }
        help="Suma de los montos de esas ventas en la moneda del negocio; otras monedas van aparte."
        loading={loading}
        unavailable={sUnavailable}
      />
    </div>
  );
}

function Highlights({ report }: { report: SummaryReportDto }) {
  const searchParams = useSearchParams();
  const items = summaryHighlights(report);
  if (items.length === 0) return null;
  const qs = searchParams.toString();
  return (
    <section
      aria-label="Lectura rápida"
      data-testid="summary-highlights"
      className="rounded-lg border bg-card p-4 shadow-sm sm:p-5 print:break-inside-avoid print:shadow-none"
    >
      <h3 className="mb-2 text-sm font-semibold">Lectura rápida</h3>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-2">
        {items.map((h) => (
          <li key={h.key} data-highlight={h.key}>
            {h.text}
            {h.agentLink && (
              <>
                {" "}
                <Link
                  href={qs ? `/reports/agent?${qs}` : "/reports/agent"}
                  className="font-medium text-brand-text underline underline-offset-2 hover:text-brand print:hidden"
                >
                  Ver detalle en Agente
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «3 · 60 %»: el conteo y su parte de las personas de la fila. */
function countRate(part: number, whole: number): string {
  if (whole === 0) return formatCount(part);
  return `${formatCount(part)} · ${formatPercent(ratio(part, whole))}`;
}

function amountOf(f: SummaryAdFiguresDto): string {
  return f.won === 0 ? EMPTY_VALUE : formatWonAmount(f.wonAmount);
}

function ByAdTable({ data, report }: { data: SummaryByAdDto; report: SummaryReportDto | null }) {
  const labels = adRowLabels(data.rows);
  const totals = report ? adTotals(report) : null;
  const truncated = data.total > data.rows.length;
  const u = data.unidentified;

  return (
    <div className="space-y-3">
      {/* Móvil: una tarjeta por anuncio. */}
      <ul className="space-y-2 md:hidden print:hidden" aria-label="Personas por anuncio">
        {data.rows.map((r) => {
          const l = labels.get(r.key);
          return (
            <li key={r.key} className="rounded-md border bg-subtle p-3">
              <p className="text-sm font-medium">{l?.title ?? r.title}</p>
              {l?.subtitle && <p className="text-xs text-text-3">{l.subtitle}</p>}
              <AdMobileStats f={r} />
            </li>
          );
        })}
        <li className="rounded-md border bg-subtle p-3">
          <p className="text-sm font-medium text-text-2">Sin anuncio identificado</p>
          <AdMobileStats f={u} />
        </li>
      </ul>

      {/* Escritorio (y papel): tabla. */}
      <div className="hidden md:block print:block">
        <table className="w-full text-sm" aria-label="Personas por anuncio">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pr-3 font-medium">Anuncio</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Personas</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Nuevas</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Mensajes</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Contestadas</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Atendidas</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Ventas</th>
              <th scope="col" className="pb-2 text-right font-medium">Monto</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const l = labels.get(r.key);
              return (
                <tr key={r.key} data-ad={r.sourceId ?? r.key} className="border-t align-top">
                  <th scope="row" className="max-w-[240px] py-2 pr-3 text-left font-normal">
                    <span className="block font-medium">{l?.title ?? r.title}</span>
                    {l?.subtitle && (
                      <span className="block text-xs text-text-3">{l.subtitle}</span>
                    )}
                  </th>
                  <AdCells f={r} />
                </tr>
              );
            })}
            <tr className="border-t align-top text-text-2" data-ad="unidentified">
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                Sin anuncio identificado
              </th>
              <AdCells f={u} />
            </tr>
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t-2 font-semibold" data-ad="total">
                <th scope="row" className="py-2 pr-3 text-left">
                  Total
                </th>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(totals.figures.persons)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(totals.figures.newPersons)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(totals.figures.inbound)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {countRate(totals.figures.answered, totals.figures.persons)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {countRate(totals.figures.attendedByAdvisor, totals.figures.persons)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(totals.figures.won)}</td>
                <td className="py-2 text-right tabular-nums">{totals.figures.amount ?? EMPTY_VALUE}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="space-y-1 text-xs text-text-3">
        {truncated && (
          <p>
            Se muestran los {formatCount(data.rows.length)} anuncios con más personas de{" "}
            {formatCount(data.total)}; el total cuenta todos.
          </p>
        )}
        <p>
          El sistema recibe el titular del anuncio, no el nombre de la campaña. «Sin anuncio
          identificado» incluye orgánico, clientes previos e Instagram/Messenger cuyo origen aún
          no se registra.
        </p>
      </div>
    </div>
  );
}

function AdCells({ f }: { f: SummaryAdFiguresDto }) {
  const note = f.won > 0 ? wonAmountNote(f.wonAmount) : null;
  return (
    <>
      <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatCount(f.persons)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.newPersons)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.inbound)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{countRate(f.answered, f.persons)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{countRate(f.attendedByAdvisor, f.persons)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.won)}</td>
      <td className="py-2 text-right tabular-nums">
        <span className="block">{amountOf(f)}</span>
        {note && <span className="block text-[11px] text-warning-text">{note}</span>}
      </td>
    </>
  );
}

function AdMobileStats({ f }: { f: SummaryAdFiguresDto }) {
  return (
    <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
      <MobileStat label="Personas" value={formatCount(f.persons)} />
      <MobileStat label="Nuevas" value={formatCount(f.newPersons)} />
      <MobileStat label="Mensajes" value={formatCount(f.inbound)} />
      <MobileStat label="Contestadas" value={countRate(f.answered, f.persons)} />
      <MobileStat label="Atendidas" value={countRate(f.attendedByAdvisor, f.persons)} />
      <MobileStat label="Ventas" value={`${formatCount(f.won)} · ${amountOf(f)}`} />
    </dl>
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

function ByChannelTable({ data }: { data: SummaryByChannelDto }) {
  return (
    <table className="w-full text-sm" aria-label="Por canal">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="pb-2 pr-2 font-medium">Canal</th>
          <th scope="col" className="pb-2 pr-2 text-right font-medium">Personas</th>
          <th scope="col" className="pb-2 pr-2 text-right font-medium">Mensajes</th>
          <th scope="col" className="pb-2 pr-2 text-right font-medium">Contestadas</th>
          <th scope="col" className="pb-2 text-right font-medium">Atendidas</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r) => (
          <tr key={r.channel} data-channel={r.channel} className="border-t">
            <th scope="row" className="py-2 pr-2 text-left font-medium">{CHANNEL_LABEL[r.channel]}</th>
            <td className="py-2 pr-2 text-right font-semibold tabular-nums">{formatCount(r.persons)}</td>
            <td className="py-2 pr-2 text-right tabular-nums">{formatCount(r.inbound)}</td>
            <td className="py-2 pr-2 text-right tabular-nums">{countRate(r.answered, r.persons)}</td>
            <td className="py-2 text-right tabular-nums">{countRate(r.attendedByAdvisor, r.persons)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Barras horizontales 0–23 h: dónde se concentra la demanda. */
function ByHourBars({ data, range }: { data: SummaryByHourDto; range: ReportRangeDto | null }) {
  // La hora actual se calcula en el cliente (nada de `new Date()` en el render
  // del servidor): solo sirve para avisar que esa barra aún no termina.
  const [currentHour, setCurrentHour] = useState<number | null>(null);
  const rangeTo = range?.to;
  const rangeTz = range?.tz;
  useEffect(() => {
    setCurrentHour(rangeTo && rangeTz ? currentHourIfToday({ to: rangeTo, tz: rangeTz }, new Date()) : null);
  }, [rangeTo, rangeTz]);

  const max = data.rows.reduce((m, r) => Math.max(m, r.inbound), 0);
  const total = data.rows.reduce((a, r) => a + r.inbound, 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">No se recibieron mensajes en este rango.</p>;
  }
  return (
    <div className="space-y-2">
      <ol className="space-y-0.5 print:space-y-0" aria-label="Mensajes recibidos por hora" data-testid="summary-by-hour">
        {data.rows.map((r) => {
          const pct = barPercent(r.inbound, max);
          const live = currentHour === r.hour;
          return (
            <li
              key={r.hour}
              // En papel, filas más bajas: las 24 horas caben en un tercio de hoja.
              className="grid grid-cols-[2.75rem_1fr_2.5rem] items-center gap-2 text-xs print:gap-1.5 print:text-[9px] print:leading-[11px]"
              aria-label={`${String(r.hour).padStart(2, "0")}:00: ${formatCount(r.inbound)} mensajes`}
            >
              <span className={`tabular-nums ${live ? "font-semibold text-foreground" : "text-text-3"}`}>
                {String(r.hour).padStart(2, "0")}:00{live ? "*" : ""}
              </span>
              <svg width="100%" height="10" aria-hidden="true" className="block print:h-[7px]">
                <rect x="0" y="0" width="100%" height="10" rx="2" style={{ fill: "var(--bg-panel)" }} />
                {r.inbound > 0 && (
                  <rect
                    x="0"
                    y="0"
                    width={`${Math.max(pct, 1)}%`}
                    height="10"
                    rx="2"
                    style={{ fill: "var(--accent)" }}
                  />
                )}
              </svg>
              <span className="text-right font-medium tabular-nums">{formatCount(r.inbound)}</span>
            </li>
          );
        })}
      </ol>
      {currentHour !== null && (
        <p className="text-xs text-text-3" data-testid="summary-hour-live">
          * El rango incluye hoy: la hora en curso ({String(currentHour).padStart(2, "0")}:00) aún
          no termina.
        </p>
      )}
    </div>
  );
}

function PendingList({ data, tz }: { data: SummaryPendingDto; tz: string }) {
  if (data.total === 0) {
    return <p className="text-sm text-muted-foreground">Nadie espera respuesta.</p>;
  }
  const more = data.total - data.rows.length;
  const contact = (r: SummaryPendingDto["rows"][number]) => {
    const name = r.contactName?.trim() || "Contacto sin nombre";
    return (
      <>
        <Link
          href={`/inbox?contact=${encodeURIComponent(r.contactId)}`}
          className="font-medium text-brand-text hover:underline print:hidden"
        >
          {name}
        </Link>
        <span className="hidden font-medium print:inline">{name}</span>
      </>
    );
  };
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums" data-testid="summary-pending-total">
          {formatCount(data.total)}
        </span>{" "}
        <span className="text-muted-foreground">
          {data.total === 1 ? "persona sin respuesta" : "personas sin respuesta"}
        </span>
      </p>

      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Pendientes de respuesta">
        {data.rows.map((r) => (
          <li key={r.conversationId} className="rounded-md border bg-subtle p-3 text-sm">
            {contact(r)}
            <p className="mt-0.5 text-xs text-text-3">
              {formatDateTime(r.lastInboundAt, tz)} · {CHANNEL_LABEL[r.channel]}
              {r.adTitle ? ` · ${r.adTitle}` : ""}
            </p>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-sm sm:table print:table" aria-label="Pendientes de respuesta">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Llegó</th>
            <th scope="col" className="pb-2 pr-3 font-medium">Canal</th>
            <th scope="col" className="pb-2 pr-3 font-medium">Anuncio</th>
            <th scope="col" className="pb-2 font-medium">Contacto</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.conversationId} className="border-t align-top" data-pending={r.conversationId}>
              <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatDateTime(r.lastInboundAt, tz)}</td>
              <td className="py-2 pr-3">{CHANNEL_LABEL[r.channel]}</td>
              <td className="py-2 pr-3 text-text-2">{r.adTitle ?? EMPTY_VALUE}</td>
              <td className="py-2">{contact(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && (
        <p className="text-xs text-text-3">y {formatCount(more)} más.</p>
      )}
    </div>
  );
}

function HowCounted({ tz }: { tz: string }) {
  const items: [string, string][] = [
    ["Mensajes recibidos", "los que escribieron los clientes en el rango."],
    [
      "Personas",
      "conversaciones con al menos un mensaje recibido en el rango. Nuevas: las de un contacto que se creó en el rango.",
    ],
    [
      "Contestadas",
      "personas que recibieron cualquier respuesta (IA, asesor o plantilla) después de su primer mensaje del rango, aunque haya salido después del rango.",
    ],
    [
      "Atendidas por un asesor",
      "personas a las que una persona del equipo les respondió después de su primer mensaje del rango.",
    ],
    [
      "Tiempo hasta que atiende un asesor",
      "desde el primer mensaje del rango hasta la primera respuesta de una persona del equipo, aunque antes haya contestado la IA.",
    ],
    [
      "Ventas",
      "leads que hoy están en Ganado, contados el día en que se ganaron (como en la pestaña Ventas). Si después se reabren dejan de contar.",
    ],
  ];
  return (
    <section
      aria-label="Cómo se cuenta"
      data-testid="summary-how-counted"
      className="rounded-lg border bg-subtle p-4 text-xs text-text-2 print:break-inside-avoid sm:p-5"
    >
      <h3 className="mb-2 text-sm font-semibold text-foreground">Cómo se cuenta</h3>
      <dl className="space-y-1">
        {items.map(([term, def]) => (
          <div key={term}>
            <dt className="inline font-semibold text-foreground">{term}: </dt>
            <dd className="inline">{def}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2">Excluye el Laboratorio. Días y horas en {tz}.</p>
    </section>
  );
}
