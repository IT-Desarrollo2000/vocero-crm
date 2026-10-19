"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Clock, Inbox } from "lucide-react";
import { MiniaturaDeAnuncio } from "@/components/anuncio-origen";
import { Button } from "@/components/ui/button";
import type {
  AdRowDto,
  AdsReportDto,
  AdsSourceRowDto,
  AdsSummaryDto,
  ReportBlock,
  WonAmountDto,
} from "@/lib/reports";
import {
  ADS_REPORT_HELP,
  adTypeLabel,
  classifyAdsReportResponse,
  formatChange,
  formatWonAmount,
  isAdsReportEmpty,
  totalWonWithoutAmount,
  wonAmountNote,
  type AdsReportOutcome,
} from "./ads-report-format";
import { formatCount, formatDayRange, formatPercent } from "./format";
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

type Failure = Exclude<AdsReportOutcome, { kind: "ok" }>;

/**
 * 020 fase B — Reportes → Anuncios. Pide `GET /api/reports/ads` con el mismo
 * rango de la URL que las otras pestañas y pinta cada bloque por su cuenta:
 * resumen, por fuente y por anuncio (con miniatura y monto ganado, D2).
 */
export function AdsReportClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selection = useMemo(() => parseRangeParams(searchParams), [searchParams]);
  const query = rangeToQuery(selection);

  const [report, setReport] = useState<AdsReportDto | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setFailure(null);
    void (async () => {
      const res = await fetch(`/api/reports/ads?${query}`, {
        signal: ctrl.signal,
      }).catch(() => null);
      if (ctrl.signal.aborted) return;
      const body: unknown = res ? await res.json().catch(() => null) : null;
      if (ctrl.signal.aborted) return;
      const outcome: AdsReportOutcome = res
        ? classifyAdsReportResponse(res.status, body)
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
  const empty = report ? isAdsReportEmpty(report) : false;
  const showBlocks = loading || !!report;
  const sinMonto = report ? totalWonWithoutAmount(report) : 0;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 print:space-y-4 print:p-0">
      <div className="print:hidden">
        <RangePicker
          key={query}
          value={selection}
          onChange={select}
          timezone={range?.tz ?? null}
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
          Aún no llegaron conversaciones ni leads en este rango.
        </p>
      )}

      {!loading && sinMonto > 0 && (
        <p
          role="status"
          data-testid="won-without-amount"
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
          {/* 021 D1b — Anuncios mide por cohorte de llegada; Ventas, por la fecha
              del cierre. La nota evita que dirección compare peras con manzanas. */}
          <p className="text-xs text-text-3" data-testid="ads-sales-note">
            Aquí una venta cuenta en el periodo en que llegó el lead. En la pestaña
            Ventas cuenta por la fecha en que se ganó, por eso los números pueden
            diferir.
          </p>

          <ReportSection
            title="Por fuente"
            description={ADS_REPORT_HELP.source}
            block={report?.bySource}
            loading={loading}
          >
            {(data) => <SourcesTable rows={data.rows} />}
          </ReportSection>

          <ReportSection
            title="Por anuncio"
            description={`${ADS_REPORT_HELP.leads} ${ADS_REPORT_HELP.won}`}
            block={report?.byAd}
            loading={loading}
          >
            {(data) =>
              data.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Ningún lead llegó por un anuncio o una publicación en este rango.
                </p>
              ) : (
                <div className="space-y-3">
                  <AdsTable rows={data.rows} />
                  <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-3">
                    <span>
                      {data.total > data.rows.length
                        ? `Los ${formatCount(data.rows.length)} con más leads de ${formatCount(data.total)}.`
                        : `${formatCount(data.total)} ${data.total === 1 ? "origen" : "orígenes"}.`}
                    </span>
                    <Link
                      href="/inbox?origin=ad"
                      className="font-medium text-brand-text underline underline-offset-2 hover:text-brand print:hidden"
                    >
                      Ver conversaciones de anuncio en la Bandeja
                    </Link>
                  </p>
                </div>
              )
            }
          </ReportSection>

          {range && (
            <p className="text-xs text-text-3">
              {ADS_REPORT_HELP.amount} Excluye el Laboratorio. Días en {range.tz}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function changeDetail(
  current: number,
  previous: number | undefined,
  prevRange: { from: string; to: string } | null | undefined
): string | undefined {
  if (previous === undefined || !prevRange) return undefined;
  const c = formatChange(current, previous);
  if (!c) return undefined;
  return `${c} vs. ${formatDayRange(prevRange.from, prevRange.to)}`;
}

function Kpis({
  block,
  loading,
}: {
  block: ReportBlock<AdsSummaryDto> | undefined;
  loading: boolean;
}) {
  const d = block?.ok ? block.data : null;
  const prev = d?.previous ?? null;
  const unavailable = !loading && !d;
  const note = d ? wonAmountNote(d.adWonAmount) : null;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5 print:grid-cols-3"
      role="group"
      aria-label="Resumen de anuncios"
    >
      <KpiTile
        label="Conversaciones nuevas"
        testId="kpi-ads-conversations"
        value={d ? formatCount(d.conversations) : "—"}
        detail={d ? changeDetail(d.conversations, prev?.conversations, prev) : undefined}
        help={ADS_REPORT_HELP.conversations}
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Vinieron de anuncio"
        testId="kpi-ads-share"
        value={d ? formatPercent(d.adShare) : "—"}
        detail={d ? `${formatCount(d.adConversations)} conversaciones` : undefined}
        help={`Conversaciones nuevas cuya fuente es «Anuncio». ${ADS_REPORT_HELP.source}`}
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Leads de anuncio"
        testId="kpi-ads-leads"
        value={d ? formatCount(d.adLeads) : "—"}
        detail={d ? changeDetail(d.adLeads, prev?.adLeads, prev) : undefined}
        help={ADS_REPORT_HELP.leads}
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Ventas de anuncio"
        testId="kpi-ads-won"
        value={d ? formatCount(d.adWon) : "—"}
        detail={
          d
            ? `${formatPercent(d.adLeads > 0 ? d.adWon / d.adLeads : null)} de cierre`
            : undefined
        }
        help={ADS_REPORT_HELP.won}
        loading={loading}
        unavailable={unavailable}
      />
      <KpiTile
        label="Monto ganado de anuncio"
        testId="kpi-ads-amount"
        value={d ? formatWonAmount(d.adWonAmount) : "—"}
        detail={
          d
            ? (note ??
              changeDetail(d.adWonAmount.amountCents, prev?.adWonAmount.amountCents, prev))
            : undefined
        }
        help={ADS_REPORT_HELP.amount}
        loading={loading}
        unavailable={unavailable}
      />
    </div>
  );
}

function AmountCell({ amount, won }: { amount: WonAmountDto; won: number }) {
  const note = wonAmountNote(amount);
  return (
    <>
      <span className="block font-medium tabular-nums">
        {won === 0 ? "—" : formatWonAmount(amount)}
      </span>
      {note && <span className="block text-[11px] text-warning-text">{note}</span>}
    </>
  );
}

function SourcesTable({ rows }: { rows: AdsSourceRowDto[] }) {
  return (
    <>
      {/* Móvil: una tarjeta por fuente; la tabla de 6 columnas no cabe. */}
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Por fuente">
        {rows.map((r) => {
          const vacia = r.conversations === 0 && r.leads === 0;
          const note = wonAmountNote(r.wonAmount);
          return (
            <li
              key={r.value}
              data-source={r.value}
              className={`rounded-md border bg-subtle p-3 ${vacia ? "text-text-3" : ""}`}
            >
              <p className="text-sm font-medium">{r.label}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <MobileStat label="Conversaciones" value={formatCount(r.conversations)} />
                <MobileStat label="Leads" value={formatCount(r.leads)} />
                <MobileStat label="Ventas" value={formatCount(r.won)} />
                <MobileStat label="Cierre" value={formatPercent(r.winRate)} />
                <MobileStat
                  label="Monto"
                  value={r.won === 0 ? "—" : formatWonAmount(r.wonAmount)}
                />
              </dl>
              {note && <p className="mt-1 text-[11px] text-warning-text">{note}</p>}
            </li>
          );
        })}
      </ul>

      {/* Escritorio (y papel): tabla. */}
      <div className="hidden sm:block print:block">
      <table className="w-full text-sm" aria-label="Por fuente">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Fuente</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Conversaciones</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Leads</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Ventas</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Cierre</th>
            <th scope="col" className="pb-2 text-right font-medium">Monto ganado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const vacia = r.conversations === 0 && r.leads === 0;
            return (
              <tr
                key={r.value}
                data-source={r.value}
                className={`border-t align-top ${vacia ? "text-text-3" : ""}`}
              >
                <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                  {r.label}
                </th>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(r.conversations)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(r.leads)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(r.won)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatPercent(r.winRate)}</td>
                <td className="py-2.5 text-right">
                  <AmountCell amount={r.wonAmount} won={r.won} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}

function AdsTable({ rows }: { rows: AdRowDto[] }) {
  return (
    <>
      {/* Escritorio (y papel): tabla. */}
      <table className="hidden w-full text-sm sm:table print:table" aria-label="Por anuncio">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">Anuncio</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Leads</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Ventas</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Cierre</th>
            <th scope="col" className="pb-2 text-right font-medium">Monto ganado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-ad={r.sourceId ?? r.key} className="border-t align-middle">
              <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                <AdIdentity row={r} />
              </th>
              <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{formatCount(r.leads)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{formatCount(r.won)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{formatPercent(r.winRate)}</td>
              <td className="py-2.5 text-right">
                <AmountCell amount={r.wonAmount} won={r.won} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Móvil: una tarjeta por anuncio, sin columnas apretadas. */}
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Por anuncio">
        {rows.map((r) => (
          <li key={r.key} data-ad={r.sourceId ?? r.key} className="rounded-md border bg-subtle p-3">
            <AdIdentity row={r} />
            <dl className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
              <MobileStat label="Leads" value={formatCount(r.leads)} />
              <MobileStat label="Ventas" value={formatCount(r.won)} />
              <MobileStat label="Cierre" value={formatPercent(r.winRate)} />
              <MobileStat label="Monto" value={r.won === 0 ? "—" : formatWonAmount(r.wonAmount)} />
            </dl>
            {wonAmountNote(r.wonAmount) && (
              <p className="mt-1 text-[11px] text-warning-text">{wonAmountNote(r.wonAmount)}</p>
            )}
          </li>
        ))}
      </ul>
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

function AdIdentity({ row }: { row: AdRowDto }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <MiniaturaDeAnuncio src={row.imageUrl} titular={row.title} />
      <span className="min-w-0">
        <span className="block truncate font-medium" title={row.title}>
          {row.title}
        </span>
        <span className="block truncate text-xs text-text-3">
          {adTypeLabel(row)}
          {row.sourceId ? ` · ID ${row.sourceId}` : ""}
        </span>
      </span>
    </span>
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
