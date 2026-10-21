"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Clock, Hourglass, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AttendanceSliceDto,
  BookingCountsDto,
  BookingReportDto,
  BookingToSalesDto,
  BookingsBySellerDto,
  BookingsByTypeDto,
} from "@/lib/reports";
import { formatWonAmount, wonAmountNote } from "./ads-report-format";
import {
  BOOKING_REPORT_SOON_MESSAGE,
  attendanceDetail,
  classifyBookingReportResponse,
  isBookingReportEmpty,
  offerDataSinceNote,
  offerDetail,
  pendingToMarkLabel,
  type BookingReportOutcome,
} from "./bookings-report-format";
import { EMPTY_VALUE, formatCount, formatPercent } from "./format";
import { KpiTile } from "./kpi-tile";
import { RangePicker } from "./range-picker";
import {
  DEFAULT_RANGE,
  canSuggestShorter,
  parseRangeParams,
  rangeToQuery,
  type RangeSelection,
} from "./range-params";
import { TIMEOUT_MESSAGE } from "./report-fetch";
import { useReportPrintMeta } from "./report-print";
import { ReportSection } from "./report-section";

type Failure = Exclude<BookingReportOutcome, { kind: "ok" }>;

/**
 * 10 — Reportes → Citas. Pide `GET /api/reports/bookings` con el mismo rango
 * de la URL que la pestaña Agente y pinta cada bloque por su cuenta: oferta →
 * cita, asistencia y asistencia con vs sin recordatorio.
 */
export function BookingsReportClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selection = useMemo(() => parseRangeParams(searchParams), [searchParams]);
  const query = rangeToQuery(selection);

  const [report, setReport] = useState<BookingReportDto | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setFailure(null);
    void (async () => {
      const res = await fetch(`/api/reports/bookings?${query}`, {
        signal: ctrl.signal,
      }).catch(() => null);
      if (ctrl.signal.aborted) return;
      const body: unknown = res ? await res.json().catch(() => null) : null;
      if (ctrl.signal.aborted) return;
      const outcome: BookingReportOutcome = res
        ? classifyBookingReportResponse(res.status, body)
        : { kind: "error" };
      if (outcome.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      if (outcome.kind === "ok") {
        setReport(outcome.report);
      } else {
        setReport(null);
        setFailure(outcome);
      }
      setLoading(false);
    })();
    return () => ctrl.abort();
  }, [query, attempt, router]);

  function select(next: RangeSelection) {
    router.replace(`${pathname}?${rangeToQuery(next)}`, { scroll: false });
  }

  const range = report?.range ?? null;
  useReportPrintMeta(range);
  const tz = range?.tz ?? null;
  const empty = report ? isBookingReportEmpty(report) : false;
  const showBlocks = loading || !!report;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 print:space-y-4 print:p-0">
      <div className="print:hidden">
        <RangePicker
          key={query}
          value={selection}
          onChange={select}
          timezone={tz}
          resolved={range ? { from: range.from, to: range.to } : null}
          disabled={loading}
        />
      </div>

      {failure && (
        <ReportFailure
          failure={failure}
          onRetry={() => setAttempt((a) => a + 1)}
          onShorter={() => select(DEFAULT_RANGE)}
          canShorten={canSuggestShorter(selection)}
        />
      )}

      {!loading && empty && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border bg-subtle px-4 py-3 text-sm text-muted-foreground"
        >
          <Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />
          Aún no hay ofertas ni citas en este rango.
        </p>
      )}

      {showBlocks && (
        <>
          <Kpis report={report} loading={loading} />

          {/* 024 — En papel también lado a lado: con las tres secciones nuevas,
              apiladas dejaban una línea suelta en una tercera hoja. */}
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2 print:grid-cols-2">
            <ReportSection
              title="Oferta → cita"
              description="Conversaciones a las que la IA les ofreció horarios y que terminaron en una cita agendada por la IA."
              block={report?.offers}
              loading={loading}
            >
              {(data) => (
                <div className="space-y-2 text-sm">
                  <Row label="Conversaciones con oferta" value={formatCount(data.conversationsWithOffer)} />
                  <Row label="Terminaron en cita" value={formatCount(data.converted)} />
                  <Row label="Conversión" value={formatPercent(data.rate)} />
                  <Row label="Rondas de horarios ofrecidas" value={formatCount(data.offerRounds)} />
                  <p className="text-xs text-text-3">
                    {offerDataSinceNote(data.dataSince, tz ?? "UTC")}
                  </p>
                </div>
              )}
            </ReportSection>

            <ReportSection
              title="Asistencia"
              description="Citas del rango marcadas como realizadas o como no asistió."
              block={report?.attendance}
              loading={loading}
            >
              {(data) => (
                <div className="space-y-2 text-sm">
                  <Row label="Realizadas" value={formatCount(data.realizada)} />
                  <Row label="No asistió" value={formatCount(data.noShow)} />
                  <Row label="Asistencia" value={formatPercent(data.rate)} />
                  <Row label="Canceladas" value={formatCount(data.cancelada)} />
                  <p
                    className={
                      data.pendingToMark > 0 ? "text-xs text-warning-text" : "text-xs text-text-3"
                    }
                  >
                    {pendingToMarkLabel(data)}
                    {data.pendingToMark > 0 && " — márcalas en Citas para que cuenten."}
                  </p>
                </div>
              )}
            </ReportSection>
          </div>

          <ReportSection
            title="Asistencia con vs sin recordatorio"
            description="«Con» = al menos un recordatorio enviado para la hora vigente de la cita."
            block={report?.byReminder}
            loading={loading}
          >
            {(data) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <SliceCard title="Con recordatorio" slice={data.withReminder} testId="slice-with-reminder" />
                <SliceCard title="Sin recordatorio" slice={data.withoutReminder} testId="slice-without-reminder" />
              </div>
            )}
          </ReportSection>

          <ReportSection
            title="Por tipo de cita"
            description="Citas con hora en el rango, por su tipo. «Agendadas» = todas las del rango, en cualquier estado."
            block={report?.byType}
            loading={loading}
            // Tablas cortas: en papel no dejan una fila suelta en otra hoja.
            className="print:break-inside-avoid"
          >
            {(data) => <ByTypeTable data={data} />}
          </ReportSection>

          <ReportSection
            title="Por vendedor"
            description="Por el vendedor de la cita (no por quién atiende la conversación), y cómo se agendaron: a mano o por la IA."
            block={report?.bySeller}
            loading={loading}
            // Tablas cortas: en papel no dejan una fila suelta en otra hoja.
            className="print:break-inside-avoid"
          >
            {(data) => <BySellerTable data={data} />}
          </ReportSection>

          <ReportSection
            title="Citas que terminaron en venta"
            description="De las citas realizadas en el rango, cuántos leads están en Ganado: ganado al momento de generar el reporte (la venta pudo ser de otro periodo)."
            block={report?.toSales}
            loading={loading}
            className="print:break-inside-avoid"
          >
            {(data) => <ToSales data={data} />}
          </ReportSection>

          {/* En papel lo dice el encabezado de impresión (rango, zona y «no
              incluye el Laboratorio»): sola, esta línea caía en otra hoja. */}
          {range && (
            <p className="text-xs text-text-3 print:hidden">
              Excluye el Laboratorio. Días en {range.tz}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const TH = "pb-2 pr-3 text-right font-medium";
const TD = "py-2 pr-3 text-right tabular-nums";

/** Las cinco cifras de un conjunto de citas, como celdas. */
function CountCells({ c }: { c: BookingCountsDto }) {
  return (
    <>
      <td className={`${TD} font-semibold`}>{formatCount(c.total)}</td>
      <td className={TD}>{formatCount(c.realizada)}</td>
      <td className={TD}>{formatCount(c.noShow)}</td>
      <td className={TD}>{formatCount(c.cancelada)}</td>
      <td className="py-2 text-right tabular-nums">{formatPercent(c.rate)}</td>
    </>
  );
}

function CountHeads() {
  return (
    <>
      <th scope="col" className={TH}>Agendadas</th>
      <th scope="col" className={TH}>Realizadas</th>
      <th scope="col" className={TH}>No asistió</th>
      <th scope="col" className={TH}>Canceladas</th>
      <th scope="col" className="pb-2 text-right font-medium">Asistencia</th>
    </>
  );
}

function CountStats({ c }: { c: BookingCountsDto }) {
  return (
    <>
      <MobileStat label="Agendadas" value={formatCount(c.total)} />
      <MobileStat label="Realizadas" value={formatCount(c.realizada)} />
      <MobileStat label="No asistió" value={formatCount(c.noShow)} />
      <MobileStat label="Canceladas" value={formatCount(c.cancelada)} />
      <MobileStat label="Asistencia" value={formatPercent(c.rate)} />
    </>
  );
}

function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-text-3">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

type TypeRow = BookingsByTypeDto["rows"][number];
type SellerRow = BookingsBySellerDto["rows"][number];

function TypeLabel({ r }: { r: TypeRow }) {
  return (
    <>
      {r.name}
      {r.typeId && !r.active && (
        <span className="ml-1.5 text-xs font-normal text-text-3">(inactivo)</span>
      )}
    </>
  );
}

/** 024 — Por tipo de cita: todos los tipos activos (también en cero) y «Sin tipo». */
function ByTypeTable({ data }: { data: BookingsByTypeDto }) {
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay tipos de cita.</p>;
  }
  return (
    <>
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Citas por tipo">
        {data.rows.map((r) => (
          <li key={r.typeId ?? "none"} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.typeId ? "" : "text-text-3"}`}>
              <TypeLabel r={r} />
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <CountStats c={r} />
            </dl>
          </li>
        ))}
      </ul>
      <table
        className="hidden w-full text-sm sm:table print:table"
        aria-label="Citas por tipo"
        data-testid="bookings-by-type"
      >
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Tipo</th>
            <CountHeads />
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr
              key={r.typeId ?? "none"}
              data-type={r.typeId ?? "none"}
              className={`border-t align-top ${r.typeId ? "" : "text-text-3"}`}
            >
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                <TypeLabel r={r} />
              </th>
              <CountCells c={r} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** «3 · 1»: manual · IA. */
function sourceText(r: SellerRow): string {
  return `${formatCount(r.bySource.manual)} · ${formatCount(r.bySource.ai)}`;
}

function SellerLabel({ r }: { r: SellerRow }) {
  return (
    <>
      {r.name}
      {r.userId && !r.isMember && (
        <span className="ml-1.5 text-xs font-normal text-text-3">(ya no es miembro)</span>
      )}
    </>
  );
}

/** 024 — Por vendedor de la cita (todos los miembros y «Sin vendedor»). */
function BySellerTable({ data }: { data: BookingsBySellerDto }) {
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin vendedores.</p>;
  }
  return (
    <>
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Citas por vendedor">
        {data.rows.map((r) => (
          <li key={r.userId ?? "none"} className="rounded-md border bg-subtle p-3">
            <p className={`text-sm font-medium ${r.userId ? "" : "text-text-3"}`}>
              <SellerLabel r={r} />
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <CountStats c={r} />
              <MobileStat label="Manual · IA" value={sourceText(r)} />
            </dl>
          </li>
        ))}
      </ul>
      <table
        className="hidden w-full text-sm sm:table print:table"
        aria-label="Citas por vendedor"
        data-testid="bookings-by-seller"
      >
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Vendedor</th>
            <th scope="col" className={TH}>Manual · IA</th>
            <CountHeads />
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr
              key={r.userId ?? "none"}
              data-seller={r.userId ?? "none"}
              className={`border-t align-top ${r.userId ? "" : "text-text-3"}`}
            >
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                <SellerLabel r={r} />
              </th>
              <td className={`${TD} text-text-2`}>{sourceText(r)}</td>
              <CountCells c={r} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 024 — Citas realizadas → leads hoy en Ganado. */
function ToSales({ data }: { data: BookingToSalesDto }) {
  if (data.bookingsDone === 0) {
    return <p className="text-sm text-muted-foreground">Ninguna cita realizada en este rango.</p>;
  }
  const note = data.won > 0 ? wonAmountNote(data.wonAmount) : null;
  const sinLead =
    data.withoutLead === 1
      ? " 1 cita realizada no tiene lead y no cuenta."
      : data.withoutLead > 1
        ? ` ${formatCount(data.withoutLead)} citas realizadas no tienen lead y no cuentan.`
        : "";
  return (
    <div className="space-y-2 text-sm" data-testid="bookings-to-sales">
      <Row label="Citas realizadas" value={formatCount(data.bookingsDone)} />
      <Row label="Leads con cita realizada" value={formatCount(data.leads)} />
      <Row label="Hoy en Ganado" value={formatCount(data.won)} />
      <Row label="Tasa" value={formatPercent(data.rate)} />
      <Row
        label="Monto ganado"
        value={data.won > 0 ? formatWonAmount(data.wonAmount) : EMPTY_VALUE}
      />
      {note && <p className="text-xs text-warning-text">{note}</p>}
      <p className="text-xs text-text-3">
        Ganado al momento de generar el reporte: la venta pudo cerrarse en otro periodo.{sinLead}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function SliceCard({
  title,
  slice,
  testId,
}: {
  title: string;
  slice: AttendanceSliceDto;
  testId: string;
}) {
  return (
    <div
      role="group"
      aria-label={`${title}: ${formatPercent(slice.rate)}`}
      data-testid={testId}
      className="rounded-md border bg-subtle p-3"
    >
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatPercent(slice.rate)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{attendanceDetail(slice)}</p>
    </div>
  );
}

function Kpis({ report, loading }: { report: BookingReportDto | null; loading: boolean }) {
  const offers = report?.offers;
  const att = report?.attendance;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 print:grid-cols-3"
      role="group"
      aria-label="Resumen de citas"
    >
      <KpiTile
        label="Oferta → cita"
        testId="kpi-offer-conversion"
        value={offers?.ok ? formatPercent(offers.data.rate) : "—"}
        detail={offers?.ok ? offerDetail(offers.data) : undefined}
        help="Conversaciones con al menos una oferta de horarios en el rango que terminaron en una cita agendada por la IA."
        loading={loading}
        unavailable={!loading && !offers?.ok}
      />
      <KpiTile
        label="Asistencia"
        testId="kpi-attendance"
        value={att?.ok ? formatPercent(att.data.rate) : "—"}
        detail={att?.ok ? attendanceDetail(att.data) : undefined}
        help="Realizadas entre realizadas más no asistió, de las citas con hora en el rango."
        loading={loading}
        unavailable={!loading && !att?.ok}
      />
      <KpiTile
        label="Pendientes de marcar"
        testId="kpi-pending-to-mark"
        value={att?.ok ? formatCount(att.data.pendingToMark) : "—"}
        help="Citas cuya hora ya pasó y siguen como agendadas: no cuentan en la asistencia hasta marcarlas."
        loading={loading}
        unavailable={!loading && !att?.ok}
      />
    </div>
  );
}

function ReportFailure({
  failure,
  onRetry,
  onShorter,
  canShorten,
}: {
  failure: Failure;
  onRetry: () => void;
  onShorter: () => void;
  canShorten: boolean;
}) {
  if (failure.kind === "soon") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-lg border bg-subtle px-4 py-3 text-sm text-muted-foreground"
      >
        <Hourglass className="h-4 w-4 shrink-0" aria-hidden="true" />
        {BOOKING_REPORT_SOON_MESSAGE}
      </p>
    );
  }
  if (failure.kind === "timeout") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3 text-sm text-warning-text"
      >
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{TIMEOUT_MESSAGE}</span>
        {canShorten ? (
          <Button size="sm" variant="outline" onClick={onShorter}>
            Probar con 30 días
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Reintentar
          </Button>
        )}
      </div>
    );
  }
  const message =
    failure.kind === "invalid"
      ? failure.message
      : failure.kind === "forbidden"
        ? "Solo el Propietario puede ver los reportes."
        : "No se pudo cargar el reporte.";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-danger-soft bg-danger-tint px-4 py-3 text-sm text-danger-text"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {failure.kind === "error" && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      )}
      {failure.kind === "invalid" && canShorten && (
        <Button size="sm" variant="outline" onClick={onShorter}>
          Ver 30 días
        </Button>
      )}
    </div>
  );
}
