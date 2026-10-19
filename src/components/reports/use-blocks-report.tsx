"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReportRangeDto } from "@/lib/reports";
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
import {
  classifyBlocksReport,
  type BlocksReportFailure,
  type BlocksReportOutcome,
} from "./report-response";

/**
 * 021 — El marco de Ventas y Resumen, el mismo que Agente y Anuncios: lee el
 * rango de la URL (el enlace se comparte tal cual), pide
 * `GET /api/reports/<endpoint>`, sube el rango resuelto al PDF y expone el
 * selector y el aviso de fallo ya cableados.
 */
export function useBlocksReport<T extends { range: ReportRangeDto }>(
  endpoint: string,
  blocks: readonly (keyof T & string)[]
) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selection = useMemo(() => parseRangeParams(searchParams), [searchParams]);
  const query = rangeToQuery(selection);
  const blocksKey = blocks.join(",");

  const [report, setReport] = useState<T | null>(null);
  const [failure, setFailure] = useState<BlocksReportFailure<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setFailure(null);
    void (async () => {
      const res = await fetch(`/api/reports/${endpoint}?${query}`, {
        signal: ctrl.signal,
      }).catch(() => null);
      if (ctrl.signal.aborted) return;
      const body: unknown = res ? await res.json().catch(() => null) : null;
      if (ctrl.signal.aborted) return;
      const outcome: BlocksReportOutcome<T> = res
        ? classifyBlocksReport<T>(
            res.status,
            body,
            blocksKey.split(",") as (keyof T & string)[]
          )
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
  }, [endpoint, blocksKey, query, attempt, router]);

  function select(next: RangeSelection) {
    router.replace(`${pathname}?${rangeToQuery(next)}`, { scroll: false });
  }

  const range = report?.range ?? null;
  useReportPrintMeta(range);

  const picker = (
    <div className="print:hidden">
      <RangePicker
        // Remonta al cambiar el rango desde fuera (atrás/adelante del navegador).
        key={query}
        value={selection}
        onChange={select}
        timezone={range?.tz ?? null}
        resolved={range ? { from: range.from, to: range.to } : null}
        disabled={loading}
      />
    </div>
  );

  const failureNotice = failure ? (
    <ReportFailureNotice
      failure={failure}
      onRetry={() => setAttempt((a) => a + 1)}
      onShorter={() => select(DEFAULT_RANGE)}
      canShorten={canSuggestShorter(selection)}
    />
  ) : null;

  return { report, range, loading, picker, failureNotice };
}

function ReportFailureNotice<T>({
  failure,
  onRetry,
  onShorter,
  canShorten,
}: {
  failure: BlocksReportFailure<T>;
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
