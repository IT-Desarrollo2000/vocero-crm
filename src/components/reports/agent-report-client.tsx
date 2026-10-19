"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Clock, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AttentionBar } from "./attention-bar";
import { DeliveryRates, FailuresBreakdown } from "./delivery-failures";
import { EscalationsTable } from "./escalations-table";
import { formatCount, formatDuration, formatPercent } from "./format";
import { KpiTile } from "./kpi-tile";
import { RangePicker } from "./range-picker";
import {
  DEFAULT_RANGE,
  canSuggestShorter,
  parseRangeParams,
  rangeToQuery,
  type RangeSelection,
} from "./range-params";
import {
  TIMEOUT_MESSAGE,
  classifyReportResponse,
  isReportEmpty,
  type ReportOutcome,
} from "./report-fetch";
import { useReportPrintMeta } from "./report-print";
import { ReportSection } from "./report-section";
import { ResponseTimes } from "./response-times";
import type { AgentReportDto } from "./types";
import { VolumeChart } from "./volume-chart";

/**
 * 02 — Reportes → Agente. Pide `GET /api/reports/agent` con el rango de la URL
 * (RF-02-09: el enlace se comparte tal cual) y pinta cada bloque por su
 * cuenta: uno que falla dice «No disponible» y los demás siguen.
 */
export function AgentReportClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selection = useMemo(() => parseRangeParams(searchParams), [searchParams]);
  const query = rangeToQuery(selection);

  const [report, setReport] = useState<AgentReportDto | null>(null);
  const [failure, setFailure] = useState<Exclude<ReportOutcome, { kind: "ok" }> | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setFailure(null);
    void (async () => {
      const res = await fetch(`/api/reports/agent?${query}`, {
        signal: ctrl.signal,
      }).catch(() => null);
      if (ctrl.signal.aborted) return;
      const body: unknown = res ? await res.json().catch(() => null) : null;
      if (ctrl.signal.aborted) return;
      const outcome: ReportOutcome = res
        ? classifyReportResponse(res.status, body)
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
  const empty = report ? isReportEmpty(report) : false;
  const showBlocks = loading || !!report;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 print:space-y-4 print:p-0">
      <div className="print:hidden">
        <RangePicker
          // Remonta al cambiar el rango desde fuera (atrás/adelante del navegador).
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
          Aún no hay datos en este rango.
        </p>
      )}

      {showBlocks && (
        <>
          <Kpis report={report} loading={loading} />

          <ReportSection
            title="Reparto de atención"
            description="Quién atendió cada conversación activa del rango."
            block={report?.attention}
            loading={loading}
          >
            {(data) => <AttentionBar data={data} />}
          </ReportSection>

          <ReportSection
            title="Volumen por día y canal"
            description="Mensajes entrantes y salientes por día, en la zona horaria del negocio."
            block={report?.volume}
            loading={loading}
          >
            {(data) => <VolumeChart data={data} days={range?.days ?? []} />}
          </ReportSection>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <ReportSection
              title="Escalamientos por motivo"
              description="Por qué el agente pasó la conversación a una persona."
              block={report?.escalations}
              loading={loading}
            >
              {(data) => <EscalationsTable data={data} timezone={tz ?? "UTC"} />}
            </ReportSection>

            <ReportSection
              title="Tiempo a primera respuesta"
              description="Desde que el cliente escribe (tras 24 h sin mensajes) hasta la primera respuesta."
              block={report?.responseTimes}
              loading={loading}
            >
              {(data) => (
                <ResponseTimes
                  data={data}
                  afterHandoff={report?.afterHandoff?.ok ? report.afterHandoff.data : null}
                />
              )}
            </ReportSection>

            <ReportSection
              title="Salientes fallidas"
              description="Mensajes que el canal rechazó, por canal y origen."
              block={report?.failures}
              loading={loading}
            >
              {(data) => <FailuresBreakdown data={data} />}
            </ReportSection>

            <ReportSection
              title="Entrega y lectura"
              description="Solo canales que confirman la entrega."
              block={report?.delivery}
              loading={loading}
            >
              {(data) => <DeliveryRates data={data} />}
            </ReportSection>
          </div>

          {range && (
            <p className="text-xs text-text-3">
              Excluye el Laboratorio. Días en {range.tz}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Kpis({ report, loading }: { report: AgentReportDto | null; loading: boolean }) {
  const att = report?.attention;
  const esc = report?.escalations;
  const rt = report?.responseTimes;
  const fail = report?.failures;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5 print:grid-cols-3"
      role="group"
      aria-label="Resumen del agente"
    >
      <KpiTile
        label="Conversaciones activas"
        testId="kpi-active"
        value={att?.ok ? formatCount(att.data.active) : "—"}
        help="Conversaciones con al menos un mensaje del cliente en el rango."
        loading={loading}
        unavailable={!loading && !att?.ok}
      />
      <KpiTile
        label="Solo IA"
        testId="kpi-ai-only"
        value={att?.ok ? formatPercent(att.data.aiOnlyRate) : "—"}
        detail={att?.ok ? `${formatCount(att.data.aiOnly)} conversaciones` : undefined}
        help="De las activas: respondió la IA, ninguna persona y no se escaló."
        loading={loading}
        unavailable={!loading && !att?.ok}
      />
      <KpiTile
        label="Escalamientos"
        testId="kpi-escalations"
        value={esc?.ok ? formatCount(esc.data.total) : "—"}
        detail={esc?.ok && esc.data.approximate ? "Datos aproximados" : undefined}
        help="Veces que el agente pasó una conversación a una persona. No incluye las pausas por respuesta manual."
        loading={loading}
        unavailable={!loading && !esc?.ok}
      />
      <KpiTile
        label="Respuesta IA (mediana)"
        testId="kpi-ai-p50"
        value={rt?.ok ? formatDuration(rt.data.ai.p50Seconds) : "—"}
        detail={
          rt?.ok ? `Humano: ${formatDuration(rt.data.human.p50Seconds)}` : undefined
        }
        help="Mediana del tiempo a primera respuesta por sesión, cuando respondió la IA."
        loading={loading}
        unavailable={!loading && !rt?.ok}
      />
      <KpiTile
        label="Salientes fallidas"
        testId="kpi-failed"
        value={fail?.ok ? formatPercent(fail.data.rate) : "—"}
        detail={
          fail?.ok
            ? `${formatCount(fail.data.failed)} de ${formatCount(fail.data.total)}`
            : undefined
        }
        help="Mensajes salientes fallidos entre todos los salientes del rango."
        loading={loading}
        unavailable={!loading && !fail?.ok}
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
  failure: Exclude<ReportOutcome, { kind: "ok" }>;
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
