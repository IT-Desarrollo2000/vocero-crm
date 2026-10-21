"use client";

import { Users } from "lucide-react";
import type {
  ReportBlock,
  SellerRosterRowDto,
  SellersFunnelDto,
  SellersReportDto,
  SellersRosterDto,
} from "@/lib/reports";
import { formatMoneyCents } from "@/lib/money";
import { formatWonAmount, wonAmountNote } from "./ads-report-format";
import { EMPTY_VALUE, formatCount, formatDuration, formatPercent } from "./format";
import { KpiTile } from "./kpi-tile";
import { ReportSection } from "./report-section";
import { formatTicket } from "./sales-report-format";
import {
  SELLERS_BLOCKS,
  sellerResults,
  type SellerResultRow,
  type SellerResults,
} from "./sellers-report-format";
import { useBlocksReport } from "./use-blocks-report";

/**
 * 024 — Reportes → Vendedores. Pide `GET /api/reports/sellers` con el rango
 * de la URL: una fila por vendedor (todos los miembros, también en cero) con
 * su cartera y su atención, sus ventas y sus citas, y el embudo de su
 * cartera. La cartera es la asignación ACTUAL de cada conversación; la
 * respuesta humana pudo salir del CRM o del teléfono compartido.
 *
 * La tabla es ancha: se parte en «Cartera y atención» y «Resultados» (así
 * cabe en Carta), cada una con su propio scroll horizontal en pantalla y
 * tarjetas en el móvil.
 */
export function SellersReportClient() {
  const { report, range, loading, picker, failureNotice } = useBlocksReport<SellersReportDto>(
    "sellers",
    SELLERS_BLOCKS
  );
  const showBlocks = loading || !!report;
  const results = report ? sellerResults(report) : null;
  const agenda = report?.agendaEnabled ?? false;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 print:space-y-4 print:p-0">
      {picker}
      {failureNotice}

      {showBlocks && (
        <>
          <Kpis roster={report?.roster} results={results} loading={loading} />

          <ReportSection
            title="Cartera y atención"
            description="Por vendedor, según la asignación actual de cada conversación. La respuesta humana pudo salir del CRM o del teléfono compartido."
            block={report?.roster}
            loading={loading}
          >
            {(data) => <RosterTable data={data} />}
          </ReportSection>

          <ReportSection
            title="Resultados"
            description={
              agenda
                ? "Ventas del periodo (quien movió el lead a Ganado o Perdido; si fue el asistente, el asesor asignado) y citas por el vendedor de la cita."
                : "Ventas del periodo: quien movió el lead a Ganado o Perdido; si fue el asistente, el asesor asignado."
            }
            block={report?.sales}
            loading={loading}
            // Cabe en una hoja con un equipo normal: en papel no se parte
            // dejando el encabezado y una fila sueltos al pie.
            className="print:break-inside-avoid"
          >
            {() => (results ? <ResultsTable results={results} agenda={agenda} /> : null)}
          </ReportSection>

          <ReportSection
            title="Embudo por vendedor"
            description="Leads de la cartera de cada vendedor por etapa, al momento de generar el reporte (no depende del rango)."
            block={report?.funnel}
            loading={loading}
            className="print:break-inside-avoid"
          >
            {(data) => <FunnelTable data={data} />}
          </ReportSection>

          {range && <HowCounted tz={range.tz} agenda={agenda} />}
        </>
      )}
    </div>
  );
}

function Kpis({
  roster,
  results,
  loading,
}: {
  roster: ReportBlock<SellersRosterDto> | undefined;
  results: SellerResults | null;
  loading: boolean;
}) {
  const t = roster?.ok ? roster.data.totals : null;
  const sellers = roster?.ok ? roster.data.rows.filter((r) => r.userId).length : 0;
  const unavailable = !loading && !t;
  const sales = results?.salesOk ? results.total.sales : null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 print:grid-cols-4"
      role="group"
      aria-label="Resumen del equipo"
    >
      <KpiTile
        label="Personas que escribieron"
        testId="kpi-sellers-persons"
        value={t ? formatCount(t.persons) : "—"}
        detail={t ? `${formatCount(sellers)} ${sellers === 1 ? "vendedor" : "vendedores"}` : undefined}
        help="Conversaciones con al menos un mensaje recibido en el rango, sumando todas las carteras y las sin asignar (igual que el Resumen)."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Atendidas por un asesor"
        testId="kpi-sellers-attended"
        value={t ? formatPercent(t.attendedRate) : "—"}
        detail={t ? `${formatCount(t.attended)} de ${formatCount(t.persons)}` : undefined}
        help="Personas que recibieron respuesta humana (desde el CRM o el teléfono compartido) después de su primer mensaje del rango."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Pendientes de respuesta"
        testId="kpi-sellers-pending"
        value={t ? formatCount(t.pending) : "—"}
        help="Personas cuyo último mensaje es suyo y nadie le ha respondido, al momento de generar el reporte."
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Ventas ganadas"
        testId="kpi-sellers-won"
        value={sales ? formatCount(sales.won) : "—"}
        detail={sales && sales.won > 0 ? formatWonAmount(sales.wonAmount) : undefined}
        help="Leads que hoy están en Ganado y se ganaron en el rango (igual que la pestaña Ventas)."
        loading={loading}
        unavailable={!loading && !sales}
      />
    </div>
  );
}

/** «3 · 60 %»: el conteo y su parte del total de la fila. */
function countRate(part: number, rate: number | null): string {
  if (rate === null) return formatCount(part);
  return `${formatCount(part)} · ${formatPercent(rate)}`;
}

function p50(r: SellerRosterRowDto): string {
  return r.advisorFirstReply.persons > 0 ? formatDuration(r.advisorFirstReply.p50Seconds) : EMPTY_VALUE;
}

const TH = "pb-2 pr-3 text-right font-medium print:pr-2";
// Las cifras no se parten («100 %» en dos renglones); el nombre sí.
const TD = "whitespace-nowrap py-2 pr-3 text-right tabular-nums print:py-1.5 print:pr-2";

function RosterTable({ data }: { data: SellersRosterDto }) {
  const t = data.totals;
  // Los leads externos solo se mencionan si hay alguno sin contactar (con la
  // 011 apagada y sin datos la UI no habla del formulario ni de FastApp).
  const external = t.externalNotContacted > 0;
  return (
    <div className="space-y-3">
      {/* Móvil: una tarjeta por vendedor. */}
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Cartera y atención por vendedor">
        {data.rows.map((r) => (
          <li key={r.userId ?? "none"} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.userId ? "" : "text-text-3"}`}>
              {r.name}
              {r.userId && !r.isMember && <ExMember />}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <MobileStat label="Cartera" value={formatCount(r.portfolio)} />
              <MobileStat label="Asignadas" value={formatCount(r.assignedInRange)} />
              <MobileStat label="Activa" value={formatCount(r.activePortfolio)} />
              <MobileStat label="Personas" value={formatCount(r.persons)} />
              <MobileStat label="Atendidas" value={countRate(r.attended, r.attendedRate)} />
              <MobileStat label="Asesor (mediana)" value={p50(r)} />
              <MobileStat label="Pendientes" value={formatCount(r.pending)} />
              {external && <MobileStat label="Externos sin contactar" value={formatCount(r.externalNotContacted)} />}
            </dl>
          </li>
        ))}
      </ul>

      {/* Escritorio (y papel): tabla con su propio scroll horizontal. */}
      <div className="hidden overflow-x-auto sm:block print:block print:overflow-visible">
        <table
          className="w-full min-w-[760px] text-sm print:min-w-0 print:text-[10px]"
          aria-label="Cartera y atención por vendedor"
          data-testid="sellers-roster"
        >
          <thead>
            <tr className="text-left text-xs text-muted-foreground print:text-[9px]">
              <th scope="col" className="pb-2 pr-3 font-medium print:pr-2">Vendedor</th>
              <th scope="col" className={TH}>Cartera</th>
              <th scope="col" className={TH}>Asignadas en el periodo</th>
              <th scope="col" className={TH}>Cartera activa</th>
              <th scope="col" className={TH}>Personas</th>
              <th scope="col" className={TH}>Atendidas</th>
              <th scope="col" className={TH}>Hasta asesor (mediana)</th>
              <th scope="col" className={external ? TH : `${TH} pr-0`}>Pendientes</th>
              {external && <th scope="col" className={`${TH} pr-0`}>Externos sin contactar</th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr
                key={r.userId ?? "none"}
                data-seller={r.userId ?? "none"}
                className={`border-t align-top ${r.userId ? "" : "text-text-3"}`}
              >
                <th scope="row" className="max-w-[200px] py-2 pr-3 text-left font-medium print:py-1.5 print:pr-2">
                  {r.name}
                  {r.userId && !r.isMember && <ExMember />}
                </th>
                <td className={`${TD} font-semibold`}>{formatCount(r.portfolio)}</td>
                <td className={TD}>{formatCount(r.assignedInRange)}</td>
                <td className={TD}>{formatCount(r.activePortfolio)}</td>
                <td className={TD}>{formatCount(r.persons)}</td>
                <td className={TD}>{countRate(r.attended, r.attendedRate)}</td>
                <td className={TD}>{p50(r)}</td>
                <td className={`${TD} ${external ? "" : "pr-0"} ${r.pending > 0 ? "font-semibold text-warning-text" : ""}`}>
                  {formatCount(r.pending)}
                </td>
                {external && (
                  <td className={`${TD} pr-0 ${r.externalNotContacted > 0 ? "font-semibold text-warning-text" : ""}`}>
                    {formatCount(r.externalNotContacted)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold" data-seller="total">
              <th scope="row" className="py-2 pr-3 text-left print:py-1.5 print:pr-2">Total</th>
              <td className={TD}>{formatCount(t.portfolio)}</td>
              <td className={TD}>{formatCount(t.assignedInRange)}</td>
              <td className={TD}>{formatCount(t.activePortfolio)}</td>
              <td className={TD}>{formatCount(t.persons)}</td>
              <td className={TD}>{countRate(t.attended, t.attendedRate)}</td>
              <td className={TD} />
              <td className={`${TD} ${external ? "" : "pr-0"}`}>{formatCount(t.pending)}</td>
              {external && <td className={`${TD} pr-0`}>{formatCount(t.externalNotContacted)}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-text-3">
        Cartera = conversaciones que hoy tiene asignadas (según la asignación actual: si se
        reasignó, cuenta para el nuevo responsable). Pendientes y cartera activa son una foto al
        generar el reporte.
      </p>
    </div>
  );
}

function ExMember() {
  return <span className="ml-1.5 text-xs font-normal text-text-3">(ya no es miembro)</span>;
}

function amountText(r: SellerResultRow): string {
  if (!r.sales || r.sales.won === 0) return EMPTY_VALUE;
  return formatWonAmount(r.sales.wonAmount);
}

function ResultsTable({ results, agenda }: { results: SellerResults; agenda: boolean }) {
  const citas = results.bookingsOk;
  const lines = [...results.rows];
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin vendedores en este rango.</p>;
  }
  const cells = (r: SellerResultRow, total = false) => {
    const sa = r.sales;
    const bo = r.bookings;
    const note = sa && sa.won > 0 ? wonAmountNote(sa.wonAmount) : null;
    return (
      <>
        <td className={`${TD} font-semibold`}>{sa ? formatCount(sa.won) : EMPTY_VALUE}</td>
        <td className={TD}>{sa ? formatCount(sa.lost) : EMPTY_VALUE}</td>
        <td className={TD}>{sa ? formatPercent(sa.closeRate) : EMPTY_VALUE}</td>
        <td className={TD}>
          <span className="block">{amountText(r)}</span>
          {note && !total && (
            <span className="block min-w-[120px] whitespace-normal text-[11px] text-warning-text print:text-[9px]">
              {note}
            </span>
          )}
        </td>
        <td className={citas ? TD : `${TD} pr-0`}>
          {sa ? formatTicket(sa.averageTicketCents, sa.wonAmount.currency) : EMPTY_VALUE}
        </td>
        {citas && (
          <>
            <td className={`${TD} border-l pl-3 print:pl-2`}>{bo ? formatCount(bo.total) : EMPTY_VALUE}</td>
            <td className={TD}>{bo ? formatCount(bo.realizada) : EMPTY_VALUE}</td>
            <td className={TD}>{bo ? formatCount(bo.noShow) : EMPTY_VALUE}</td>
            <td className={`${TD} pr-0`}>{bo ? formatPercent(bo.rate) : EMPTY_VALUE}</td>
          </>
        )}
      </>
    );
  };
  return (
    <div className="space-y-3">
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Resultados por vendedor">
        {lines.map((r) => (
          <li key={r.key} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.muted ? "text-text-3" : ""}`}>{r.name}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              {r.sales && (
                <>
                  <MobileStat label="Ganadas" value={formatCount(r.sales.won)} />
                  <MobileStat label="Perdidas" value={formatCount(r.sales.lost)} />
                  <MobileStat label="Cierre" value={formatPercent(r.sales.closeRate)} />
                  <MobileStat label="Monto" value={amountText(r)} />
                  <MobileStat
                    label="Ticket"
                    value={formatTicket(r.sales.averageTicketCents, r.sales.wonAmount.currency)}
                  />
                </>
              )}
              {r.bookings && (
                <>
                  <MobileStat label="Citas" value={formatCount(r.bookings.total)} />
                  <MobileStat label="Realizadas" value={formatCount(r.bookings.realizada)} />
                  <MobileStat label="No asistió" value={formatCount(r.bookings.noShow)} />
                  <MobileStat label="Asistencia" value={formatPercent(r.bookings.rate)} />
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block print:block print:overflow-visible">
        <table
          className={`w-full text-sm print:min-w-0 print:text-[10px] ${citas ? "min-w-[860px]" : "min-w-[560px]"}`}
          aria-label="Resultados por vendedor"
          data-testid="sellers-results"
        >
          <thead>
            {citas && (
              <tr className="text-xs text-muted-foreground print:text-[9px]">
                <th scope="colgroup" colSpan={6} />
                <th scope="colgroup" colSpan={4} className="border-l pb-1 pl-3 text-left font-medium print:pl-2">
                  Citas del periodo
                </th>
              </tr>
            )}
            <tr className="text-left text-xs text-muted-foreground print:text-[9px]">
              <th scope="col" className="pb-2 pr-3 font-medium print:pr-2">Vendedor</th>
              <th scope="col" className={TH}>Ganadas</th>
              <th scope="col" className={TH}>Perdidas</th>
              <th scope="col" className={TH}>Cierre</th>
              <th scope="col" className={TH}>Monto ganado</th>
              <th scope="col" className={citas ? TH : `${TH} pr-0`}>Ticket promedio</th>
              {citas && (
                <>
                  <th scope="col" className={`${TH} border-l pl-3 print:pl-2`}>Agendadas</th>
                  <th scope="col" className={TH}>Realizadas</th>
                  <th scope="col" className={TH}>No asistió</th>
                  <th scope="col" className={`${TH} pr-0`}>Asistencia</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((r) => (
              <tr
                key={r.key}
                data-seller={r.userId ?? r.key}
                className={`border-t align-top ${r.muted ? "text-text-3" : ""}`}
              >
                <th scope="row" className="max-w-[200px] py-2 pr-3 text-left font-medium print:py-1.5 print:pr-2">
                  {r.name}
                </th>
                {cells(r)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold" data-seller="total">
              <th scope="row" className="py-2 pr-3 text-left print:py-1.5 print:pr-2">Total</th>
              {cells(results.total, true)}
            </tr>
          </tfoot>
        </table>
      </div>
      {agenda && !citas && (
        <p className="text-xs text-warning-text">Las citas no están disponibles por ahora.</p>
      )}
      {results.total.sales && wonAmountNote(results.total.sales.wonAmount) && (
        <p className="text-xs text-text-3">
          El total no suma monedas distintas: {wonAmountNote(results.total.sales.wonAmount)}.
        </p>
      )}
    </div>
  );
}

function FunnelTable({ data }: { data: SellersFunnelDto }) {
  const money = (c: number) => formatMoneyCents(c, data.currency) ?? EMPTY_VALUE;
  if (data.rows.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
        Ningún lead en el embudo.
      </p>
    );
  }
  const totalOpen = data.rows.reduce((a, r) => a + r.openLeads, 0);
  const totalOpenAmount = data.rows.reduce((a, r) => a + r.openAmountCents, 0);
  const stageTotal = (i: number) => data.rows.reduce((a, r) => a + (r.cells[i]?.leads ?? 0), 0);
  return (
    <div className="space-y-3">
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Embudo por vendedor">
        {data.rows.map((r) => (
          <li key={r.userId ?? "none"} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.userId ? "" : "text-text-3"}`}>{r.name}</p>
            <p className="mt-0.5 text-xs text-text-3">
              {formatCount(r.openLeads)} abiertos · {money(r.openAmountCents)}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              {data.stages.map((s, i) => (
                <MobileStat key={s.stageId} label={s.name} value={formatCount(r.cells[i]?.leads ?? 0)} />
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block print:block print:overflow-visible">
        <table
          className="w-full min-w-[640px] text-sm print:min-w-0 print:text-[10px]"
          aria-label="Embudo por vendedor"
          data-testid="sellers-funnel"
        >
          <thead>
            <tr className="text-left text-xs text-muted-foreground print:text-[9px]">
              <th scope="col" className="pb-2 pr-3 font-medium print:pr-2">Vendedor</th>
              {data.stages.map((s) => (
                <th key={s.stageId} scope="col" className={TH} data-stage={s.kind}>
                  {s.name}
                </th>
              ))}
              <th scope="col" className={`${TH} border-l pl-3 print:pl-2`}>Abiertos</th>
              <th scope="col" className={`${TH} pr-0`}>Monto abierto</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr
                key={r.userId ?? "none"}
                data-seller={r.userId ?? "none"}
                className={`border-t align-top ${r.userId ? "" : "text-text-3"}`}
              >
                <th scope="row" className="max-w-[200px] py-2 pr-3 text-left font-medium print:py-1.5 print:pr-2">
                  {r.name}
                </th>
                {data.stages.map((s, i) => {
                  const n = r.cells[i]?.leads ?? 0;
                  return (
                    <td key={s.stageId} className={`${TD} ${n === 0 ? "text-text-4" : ""}`}>
                      {formatCount(n)}
                    </td>
                  );
                })}
                <td className={`${TD} border-l pl-3 font-semibold print:pl-2`}>{formatCount(r.openLeads)}</td>
                <td className={`${TD} pr-0`}>{money(r.openAmountCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold" data-seller="total">
              <th scope="row" className="py-2 pr-3 text-left print:py-1.5 print:pr-2">Total</th>
              {data.stages.map((s, i) => (
                <td key={s.stageId} className={TD}>
                  {formatCount(stageTotal(i))}
                </td>
              ))}
              <td className={`${TD} border-l pl-3 print:pl-2`}>{formatCount(totalOpen)}</td>
              <td className={`${TD} pr-0`}>{money(totalOpenAmount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      {/* El rótulo puede ir en dos renglones («Externos sin contactar»): no se corta. */}
      <dt className="leading-tight text-text-3">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function HowCounted({ tz, agenda }: { tz: string; agenda: boolean }) {
  const items: [string, string][] = [
    [
      "Vendedores",
      "todos los miembros del equipo (vendedores y propietarios), aunque estén en cero, y quien ya no es miembro pero tiene ventas o citas en el rango. «Sin asignar» son las conversaciones sin responsable.",
    ],
    [
      "Cartera",
      "las conversaciones que cada vendedor tiene asignadas, según la asignación actual: si una conversación se reasignó, todo su historial cuenta para el responsable de hoy. Asignadas en el periodo: las que se le asignaron dentro del rango. Cartera activa: no archivadas y con el lead en una etapa abierta.",
    ],
    [
      "Atendidas",
      "personas de su cartera que escribieron en el rango y recibieron respuesta humana desde el CRM o el teléfono compartido; el CRM aún no registra quién envía cada mensaje, así que la respuesta cuenta para la cartera, no para una persona. Hasta asesor: mediana desde el primer mensaje del rango hasta esa respuesta.",
    ],
    [
      "Pendientes",
      "personas de su cartera cuyo último mensaje es suyo y nadie le ha respondido, al momento de generar el reporte (la misma regla que el Resumen). La suma de todas las filas, con «Sin asignar», da los totales del Resumen.",
    ],
    [
      "Ventas",
      "las de Ventas → Por asesor: quien movió el lead a Ganado o Perdido; si fue el asistente, el asesor asignado a la conversación; si no hay, «Sin asesor». Ticket promedio: monto entre las ventas con monto en la moneda del negocio.",
    ],
    ...(agenda
      ? ([
          [
            "Citas",
            "por el vendedor de la cita (no por la cartera), con hora en el rango; «Sin vendedor» son las citas sin vendedor. Asistencia: realizadas entre realizadas más no asistió.",
          ],
        ] as [string, string][])
      : []),
    ["Embudo por vendedor", "foto actual de los leads de la cartera de cada vendedor, por etapa."],
  ];
  return (
    <section
      aria-label="Cómo se cuenta"
      data-testid="sellers-how-counted"
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
      <p className="mt-2">
        Los montos nunca suman monedas distintas. Excluye el Laboratorio. Días en {tz}.
      </p>
    </section>
  );
}
