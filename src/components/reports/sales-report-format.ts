/**
 * 021 — Reportes → Ventas: cómo la pantalla arma sus cifras a partir de
 * `GET /api/reports/sales`. Lógica pura (sin React) para probarla en unit.
 * Semántica en `src/lib/reports.ts` (plan 021 §3.1).
 */

import { formatMoneyCents } from "@/lib/money";
import type {
  SalesFunnelDto,
  SalesFunnelStageDto,
  SalesReportDto,
  SalesSourceRowDto,
  SalesSummaryDto,
} from "@/lib/reports";
import { formatChange } from "./ads-report-format";
import { dayBarStep } from "./chart";
import { EMPTY_VALUE, formatCount, formatDayRange } from "./format";

/** Bloques que un 200 de `/api/reports/sales` debe traer. */
export const SALES_BLOCKS = [
  "summary",
  "byAdvisor",
  "lossReasons",
  "funnel",
  "timeToClose",
  "byDay",
  "bySource",
] as const satisfies readonly (keyof SalesReportDto)[];

/**
 * 021b — Filas de «Ventas por origen» que se enseñan: solo las fuentes con
 * cierres en el rango, en el orden fijo del servidor (el de Anuncios).
 */
export function salesSourceRows(rows: readonly SalesSourceRowDto[]): SalesSourceRowDto[] {
  return rows.filter((r) => r.won + r.lost > 0);
}

/**
 * ¿No hubo cierres en el rango? Solo se afirma con el resumen; el embudo es
 * una foto actual y se pinta igual.
 */
export function isSalesReportEmpty(report: SalesReportDto): boolean {
  if (!report.summary.ok) return false;
  return report.summary.data.won === 0 && report.summary.data.lost === 0;
}

/** Días de cierre legibles: «menos de 1 día», «1 día», «3.5 días»; null → «—». */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) {
    return EMPTY_VALUE;
  }
  if (days < 1) return "menos de 1 día";
  const r = Math.round(days * 10) / 10;
  if (r === 1) return "1 día";
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} días`;
}

/** Ticket promedio («$1,250.00»); null → «—». */
export function formatTicket(cents: number | null, currency: string): string {
  if (cents === null) return EMPTY_VALUE;
  return formatMoneyCents(cents, currency) ?? EMPTY_VALUE;
}

/**
 * «+25 % vs. 22 jul – 20 ago 2026» contra el periodo anterior; undefined si
 * no hay con qué comparar.
 */
export function compareDetail(
  current: number,
  previous: number | undefined,
  prevRange: { from: string; to: string } | null | undefined
): string | undefined {
  if (previous === undefined || !prevRange) return undefined;
  const c = formatChange(current, previous);
  if (!c) return undefined;
  return `${c} vs. ${formatDayRange(prevRange.from, prevRange.to)}`;
}

/**
 * Geometría del gráfico de ventas por día. Con pocos días las barras se
 * reparten en un ancho mínimo (un solo día no queda como una astilla de
 * 100 px) y nunca pasan de 40 px de grueso.
 */
export function salesDayGeometry(dayCount: number): {
  step: number;
  barWidth: number;
  plotWidth: number;
} {
  const n = Math.max(1, dayCount);
  const MIN_PLOT = 320;
  const base = dayBarStep(n);
  const step = n <= 7 ? Math.max(base, MIN_PLOT / n) : base;
  const barWidth = Math.min(40, Math.max(2, Math.round(step * 0.7)));
  return { step, barWidth, plotWidth: n * step };
}

/**
 * Notas condicionales de «Cómo se cuenta»: solo se explican las fechas
 * aproximadas y los ganados sin fecha si los hay.
 */
export function salesCaveats(s: SalesSummaryDto): string[] {
  const out: string[] = [];
  if (s.withoutDate > 0) {
    out.push(
      `${s.withoutDate === 1 ? "1 lead está" : `${formatCount(s.withoutDate)} leads están`} en Ganado sin fecha de venta registrada: no cuenta${s.withoutDate === 1 ? "" : "n"} en ningún periodo.`
    );
  }
  if (s.approximateCount > 0) {
    out.push(
      `${s.approximateCount === 1 ? "1 cierre" : `${formatCount(s.approximateCount)} cierres`} del periodo tiene${s.approximateCount === 1 ? "" : "n"} fecha aproximada (registrada antes de que el CRM guardara cada cambio de etapa): cuenta${s.approximateCount === 1 ? "" : "n"}, pero la fecha puede no ser exacta.`
    );
  }
  return out;
}

/** 032 — Lo que dice Ventas cuando el rango no tiene ventas ni perdidas. */
export type NoSalesView = {
  /** Nombre de la etapa ganada del negocio («Cliente», «Ganado»…). */
  wonName: string;
  /** Nombre de la etapa perdida («Perdido»…). */
  lostName: string;
  /** Etapas abiertas y la ganada, en su orden (las perdidas no). null sin embudo. */
  stages: SalesFunnelStageDto[] | null;
  /** Leads hoy en etapas abiertas. */
  inProcess: number;
  /** «¿Alguno de los 2 en «Interesado» ya compró? …»; null sin nadie en proceso. */
  nudge: string | null;
};

/**
 * 032 — Arma la explicación de «Ventas sin ventas» con el embudo actual
 * (foto, no depende del rango). Usa los nombres reales de las etapas: el
 * negocio pudo renombrar «Ganado». Si el embudo no llegó, rótulos genéricos.
 */
export function noSalesView(funnel: SalesFunnelDto | null): NoSalesView {
  const all = funnel ? [...funnel.stages].sort((a, b) => a.position - b.position) : [];
  const won = all.find((s) => s.kind === "won");
  const lost = all.find((s) => s.kind === "lost");
  const wonName = won?.name ?? "Ganado";
  const lostName = lost?.name ?? "Perdido";
  if (!funnel) return { wonName, lostName, stages: null, inProcess: 0, nudge: null };
  const open = all.filter((s) => s.kind === "open");
  const stages = all.filter((s) => s.kind !== "lost");
  const inProcess = open.reduce((a, s) => a + s.leads, 0);
  // La etapa abierta más avanzada con gente: ahí está quien pudo comprar.
  const closest = [...open].reverse().find((s) => s.leads > 0);
  const nudge = closest
    ? closest.leads === 1
      ? `¿El que está en «${closest.name}» ya compró? Muévelo a «${wonName}» y captura el monto.`
      : `¿Alguno de los ${formatCount(closest.leads)} que están en «${closest.name}» ya compró? Muévelo a «${wonName}» y captura el monto.`
    : null;
  return { wonName, lostName, stages, inProcess, nudge };
}
