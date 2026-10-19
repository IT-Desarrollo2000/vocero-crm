"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Inbox } from "lucide-react";
import { CHANNEL_LABEL } from "@/lib/channels";
import {
  LEAD_ORIGIN_LABEL,
  NO_ORIGIN_LABEL,
  type ReportBlock,
  type ReportRangeDto,
  type SalesSummaryDto,
  type SummaryAttentionDto,
  type SummaryByChannelDto,
  type SummaryByHourDto,
  type SummaryByOriginDto,
  type SummaryExternalLeadsDto,
  type SummaryOriginFiguresDto,
  type SummaryPendingDto,
  type SummaryReportDto,
} from "@/lib/reports";
import { formatWonAmount, wonAmountNote } from "./ads-report-format";
import { barPercent } from "./chart";
import {
  EMPTY_VALUE,
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
  ratio,
} from "./format";
import { KpiTile } from "./kpi-tile";
import { ReportSection } from "./report-section";
import { compareDetail } from "./sales-report-format";
import {
  SUMMARY_BLOCKS,
  adRowLabels,
  currentHourIfToday,
  isSummaryReportEmpty,
  rateDetail,
  showExternalOrigins,
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
  const external = report ? showExternalOrigins(report) : false;

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
          Nadie escribió ni llegó ningún lead en este rango.
        </p>
      )}

      {showBlocks && (
        <>
          <Kpis attention={report?.attention} sales={report?.sales} loading={loading} />

          {report && <Highlights report={report} />}

          <ReportSection
            title="Por origen"
            description={
              external
                ? "Leads del rango agrupados por cómo llegaron la primera vez: un anuncio, el formulario del sitio web o FastApp."
                : "Leads del rango agrupados por el primer anuncio que los trajo."
            }
            block={report?.byOrigin}
            loading={loading}
          >
            {(data) => <ByOriginTable data={data} showExternal={external} />}
          </ReportSection>

          {(loading || external) && (
            <ReportSection
              title="Leads del formulario y FastApp"
              description="Leads que llegaron en el rango desde el sitio web o la app de promotores, y si alguien ya los contactó."
              block={report?.external}
              loading={loading}
              // Dos filas: en papel la sección entera va junta.
              className="print:break-inside-avoid"
            >
              {(data) => <ExternalLeads data={data} />}
            </ReportSection>
          )}

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

          {range && <HowCounted tz={range.tz} external={external} />}
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
  const leadsDetail = a
    ? [
        `de ${a.leads === 1 ? "1 lead" : `${formatCount(a.leads)} leads`}`,
        compareDetail(a.newLeads, ap?.newLeads, ap),
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const amountNote = s ? wonAmountNote(s.wonAmount) : null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 print:grid-cols-4"
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
        label="Leads nuevos"
        testId="kpi-summary-new-leads"
        value={a ? formatCount(a.newLeads) : "—"}
        detail={a ? leadsDetail : undefined}
        help="Contactos que se crearon en el rango y escribieron o llegaron como lead externo (formulario o FastApp). El total de leads incluye también a los contactos que ya existían."
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

/** «3 · 60 %»: el conteo y su parte de los leads (o personas) de la fila. */
function countRate(part: number, whole: number): string {
  if (whole === 0) return formatCount(part);
  return `${formatCount(part)} · ${formatPercent(ratio(part, whole))}`;
}

function amountOf(f: SummaryOriginFiguresDto): string {
  return f.won === 0 ? EMPTY_VALUE : formatWonAmount(f.wonAmount);
}

type OriginLine = {
  key: string;
  /** `data-origin`: `ad` | `website` | `fast_app` | `unidentified`. */
  origin: string;
  /** `data-ad` (solo anuncios): su `source_id`. */
  ad?: string;
  title: string;
  subtitle: string | null;
  muted: boolean;
  f: SummaryOriginFiguresDto;
};

function ByOriginTable({ data, showExternal }: { data: SummaryByOriginDto; showExternal: boolean }) {
  const labels = adRowLabels(data.rows);
  const truncated = data.total > data.rows.length;
  const t = data.totals;
  const lines: OriginLine[] = [
    ...data.rows.map((r) => {
      const l = labels.get(r.key);
      return {
        key: r.key,
        origin: "ad",
        ad: r.sourceId ?? r.key,
        title: l?.title ?? r.title,
        subtitle: l?.subtitle ?? null,
        muted: false,
        f: r,
      };
    }),
    ...(showExternal
      ? [
          { key: "website", origin: "website", title: LEAD_ORIGIN_LABEL.website, subtitle: null, muted: false, f: data.website },
          { key: "fast_app", origin: "fast_app", title: LEAD_ORIGIN_LABEL.fast_app, subtitle: null, muted: false, f: data.fastApp },
        ]
      : []),
    { key: "unidentified", origin: "unidentified", title: NO_ORIGIN_LABEL, subtitle: null, muted: true, f: data.unidentified },
  ];

  return (
    <div className="space-y-3">
      {/* Móvil: una tarjeta por origen. */}
      <ul className="space-y-2 md:hidden print:hidden" aria-label="Leads por origen">
        {lines.map((line) => (
          <li key={line.key} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${line.muted ? "text-text-2" : ""}`}>{line.title}</p>
            {line.subtitle && <p className="text-xs text-text-3">{line.subtitle}</p>}
            <OriginMobileStats f={line.f} />
          </li>
        ))}
      </ul>

      {/* Escritorio (y papel): tabla. */}
      <div className="hidden md:block print:block">
        <table className="w-full text-sm print:text-xs" aria-label="Leads por origen" data-testid="summary-by-origin">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pr-3 font-medium">Origen</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Leads</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Nuevos</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Escribieron</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Mensajes</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Contactados</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Atendidos</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Ventas</th>
              <th scope="col" className="pb-2 text-right font-medium">Monto</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.key}
                data-origin={line.origin}
                data-ad={line.ad}
                className={`border-t align-top print:break-inside-avoid ${line.muted ? "text-text-2" : ""}`}
              >
                <th scope="row" className="max-w-[240px] py-2 pr-3 text-left font-normal">
                  <span className="block font-medium">{line.title}</span>
                  {line.subtitle && (
                    <span className="block text-xs text-text-3">{line.subtitle}</span>
                  )}
                </th>
                <OriginCells f={line.f} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold print:break-inside-avoid" data-origin="total">
              <th scope="row" className="py-2 pr-3 text-left">
                Total
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCount(t.leads)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCount(t.newLeads)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCount(t.wrote)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCount(t.inbound)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{countRate(t.contacted, t.leads)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{countRate(t.attendedByAdvisor, t.leads)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCount(t.won)}</td>
              <td className="py-2 text-right tabular-nums">{amountOf(t)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-1 text-xs text-text-3">
        {truncated && (
          <p>
            Se muestran los {formatCount(data.rows.length)} anuncios con más leads de{" "}
            {formatCount(data.total)}; el total cuenta todos.
          </p>
        )}
        <p>
          El sistema recibe el titular del anuncio, no el nombre de la campaña. «{NO_ORIGIN_LABEL}»
          incluye orgánico, clientes previos e Instagram/Messenger cuyo origen aún no se
          registra.
        </p>
      </div>
    </div>
  );
}

function OriginCells({ f }: { f: SummaryOriginFiguresDto }) {
  const note = f.won > 0 ? wonAmountNote(f.wonAmount) : null;
  return (
    <>
      <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatCount(f.leads)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.newLeads)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.wrote)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.inbound)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{countRate(f.contacted, f.leads)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{countRate(f.attendedByAdvisor, f.leads)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(f.won)}</td>
      <td className="py-2 text-right tabular-nums">
        <span className="block">{amountOf(f)}</span>
        {note && <span className="block text-[11px] text-warning-text">{note}</span>}
      </td>
    </>
  );
}

function OriginMobileStats({ f }: { f: SummaryOriginFiguresDto }) {
  return (
    <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
      <MobileStat label="Leads" value={formatCount(f.leads)} />
      <MobileStat label="Nuevos" value={formatCount(f.newLeads)} />
      <MobileStat label="Escribieron" value={formatCount(f.wrote)} />
      <MobileStat label="Contactados" value={countRate(f.contacted, f.leads)} />
      <MobileStat label="Atendidos" value={countRate(f.attendedByAdvisor, f.leads)} />
      <MobileStat label="Ventas" value={`${formatCount(f.won)} · ${amountOf(f)}`} />
    </dl>
  );
}

/** «17 min · 1 h» (mediana · 9 de cada 10); «—» sin contactados. */
function firstContactText(r: SummaryExternalLeadsDto["rows"][number]): string {
  if (r.firstContact.measured === 0) return EMPTY_VALUE;
  return `${formatDuration(r.firstContact.p50Seconds)} · ${formatDuration(r.firstContact.p90Seconds)}`;
}

function ExternalLeads({ data }: { data: SummaryExternalLeadsDto }) {
  return (
    <div className="space-y-3">
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Leads del formulario y FastApp">
        {data.rows.map((r) => (
          <li key={r.origin} className="rounded-md border bg-subtle p-3">
            <p className="text-sm font-medium">{r.label}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <MobileStat label="Recibidos" value={formatCount(r.received)} />
              <MobileStat label="Contactados" value={countRate(r.contacted, r.received)} />
              <MobileStat label="Sin contactar" value={formatCount(r.notContacted)} />
              <MobileStat label="Respondieron" value={countRate(r.replied, r.received)} />
              <MobileStat label="Primer contacto" value={firstContactText(r)} />
            </dl>
          </li>
        ))}
      </ul>

      <table
        className="hidden w-full text-sm sm:table print:table"
        aria-label="Leads del formulario y FastApp"
        data-testid="summary-external"
      >
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Origen</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Recibidos</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Contactados</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Sin contactar</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Respondieron</th>
            <th scope="col" className="pb-2 text-right font-medium">
              Primer contacto <span className="font-normal">(mediana · 9 de 10)</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.origin} data-external={r.origin} className="border-t align-top">
              <th scope="row" className="py-2 pr-3 text-left font-medium">{r.label}</th>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatCount(r.received)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{countRate(r.contacted, r.received)}</td>
              <td
                className={`py-2 pr-3 text-right tabular-nums ${r.notContacted > 0 ? "font-semibold text-warning-text" : ""}`}
              >
                {formatCount(r.notContacted)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{countRate(r.replied, r.received)}</td>
              <td className="py-2 text-right tabular-nums">{firstContactText(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-text-3">
        Contactado = cualquier mensaje enviado después de que llegó el lead (asesor, IA o
        plantilla). Sin contactar se cuenta al momento de generar el reporte. El primer mensaje
        suele requerir plantilla: la ventana de 24 h de WhatsApp sigue cerrada hasta que el cliente
        escribe.
      </p>
    </div>
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

function HowCounted({ tz, external }: { tz: string; external: boolean }) {
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
      "Leads",
      external
        ? "contactos que en el rango escribieron o llegaron como lead del formulario o de FastApp. Leads nuevos: los de un contacto que se creó en el rango."
        : "contactos que escribieron en el rango. Leads nuevos: los de un contacto que se creó en el rango.",
    ],
    [
      "Por origen",
      external
        ? "por dónde llegó cada lead la primera vez: su primer anuncio o su primer registro del formulario o de FastApp, lo que haya sido antes. Un cliente que llegó por un anuncio y luego dejó sus datos en el formulario sigue contando en el anuncio. Contactados: recibieron cualquier mensaje (asesor, IA o plantilla) después de su primer mensaje o registro del rango. Las ventas se cuelgan del origen del lead."
        : "por el primer anuncio que trajo a cada lead. Contactados: recibieron cualquier mensaje (asesor, IA o plantilla) después de su primer mensaje del rango. Las ventas se cuelgan del origen del lead.",
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
