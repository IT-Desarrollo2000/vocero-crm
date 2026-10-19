/**
 * 021 — Reportes → Resumen para dirección: cómo la pantalla arma sus cifras
 * y la «lectura rápida» a partir de `GET /api/reports/summary`. Lógica pura
 * (sin React) para probarla en unit. Semántica en `src/lib/reports.ts`
 * (plan 021 §3.2).
 */

import type {
  ReportRangeDto,
  SummaryAdFiguresDto,
  SummaryAdRowDto,
  SummaryReportDto,
} from "@/lib/reports";
import { formatWonAmount } from "./ads-report-format";
import { formatCount, formatDuration, formatPercent, ratio } from "./format";

/** Bloques que un 200 de `/api/reports/summary` debe traer. */
export const SUMMARY_BLOCKS = [
  "attention",
  "byAd",
  "byChannel",
  "byHour",
  "pending",
  "sales",
  "responseTimes",
] as const satisfies readonly (keyof SummaryReportDto)[];

/** ¿Nadie escribió en el rango? Solo se afirma si el bloque de atención llegó. */
export function isSummaryReportEmpty(report: SummaryReportDto): boolean {
  if (!report.attention.ok) return false;
  return report.attention.data.persons === 0 && report.attention.data.inbound === 0;
}

/** «8 de 10 · antes 70 %»: una tasa se compara con la tasa, nunca en «+25 %». */
export function rateDetail(
  part: number,
  whole: number,
  previousRate: number | null | undefined
): string {
  const base = `${formatCount(part)} de ${formatCount(whole)}`;
  if (previousRate === undefined || previousRate === null) return base;
  return `${base} · antes ${formatPercent(previousRate)}`;
}

/** Día local `YYYY-MM-DD` y hora local de `now` en la zona del negocio. */
export function nowInZone(tz: string, now: Date): { day: string; hour: number } {
  const fmt = (timeZone?: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
  };
  try {
    return fmt(tz);
  } catch {
    return fmt();
  }
}

/**
 * Si el rango incluye hoy, la hora en curso todavía no termina: la barra de
 * esa hora está incompleta. null si el rango no llega a hoy.
 */
export function currentHourIfToday(
  range: Pick<ReportRangeDto, "to" | "tz">,
  now: Date
): number | null {
  const z = nowInZone(range.tz, now);
  return z.day === range.to ? z.hour : null;
}

export type AdRowLabel = { title: string; subtitle: string | null };

/**
 * Rótulo de cada fila por anuncio. Meta manda el TITULAR, no el nombre de la
 * campaña, y varios anuncios pueden compartirlo: en ese caso debajo va
 * «anuncio <id>» para distinguirlos.
 */
export function adRowLabels(rows: readonly SummaryAdRowDto[]): Map<string, AdRowLabel> {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.title, (count.get(r.title) ?? 0) + 1);
  const out = new Map<string, AdRowLabel>();
  for (const r of rows) {
    const dup = (count.get(r.title) ?? 0) > 1;
    const kind = r.sourceType === "post" ? "publicación" : "anuncio";
    out.set(r.key, {
      title: r.title,
      subtitle: dup ? `${kind} ${r.sourceId ?? r.key}` : null,
    });
  }
  return out;
}

/**
 * Fila «Total» de la tabla por anuncio. Las filas se cortan en 50, así que
 * NO se suman: las personas salen del bloque de atención y las ventas del de
 * ventas, que cubren todo el rango. Solo si esos bloques fallaron se cae a la
 * suma de lo que hay en pantalla (y se marca como parcial).
 */
export function adTotals(report: SummaryReportDto): {
  figures: Omit<SummaryAdFiguresDto, "wonAmount"> & { amount: string | null };
  partial: boolean;
} | null {
  if (!report.byAd.ok) return null;
  const { rows, unidentified } = report.byAd.data;
  const all = [...rows, unidentified];
  const sum = (k: "persons" | "newPersons" | "inbound" | "answered" | "attendedByAdvisor" | "won") =>
    all.reduce((a, r) => a + r[k], 0);
  const att = report.attention.ok ? report.attention.data : null;
  const sales = report.sales.ok ? report.sales.data : null;
  return {
    figures: {
      persons: att ? att.persons : sum("persons"),
      newPersons: att ? att.newPersons : sum("newPersons"),
      inbound: att ? att.inbound : sum("inbound"),
      answered: att ? att.answered : sum("answered"),
      attendedByAdvisor: att ? att.attendedByAdvisor : sum("attendedByAdvisor"),
      won: sales ? sales.won : sum("won"),
      amount: sales ? formatWonAmount(sales.wonAmount) : null,
    },
    partial: !att || !sales,
  };
}

export type Highlight = { key: string; text: string; agentLink?: boolean };

/**
 * «Lectura rápida»: las 3–5 frases que dirección lee antes que las tablas.
 * Cada una sale de un bloque; si el bloque falló, la frase no aparece.
 */
export function summaryHighlights(report: SummaryReportDto): Highlight[] {
  const out: Highlight[] = [];
  const att = report.attention.ok ? report.attention.data : null;

  if (att && report.byAd.ok && att.persons > 0) {
    const fromAds = Math.max(0, att.persons - report.byAd.data.unidentified.persons);
    out.push({
      key: "ads",
      text: `${formatPercent(ratio(fromAds, att.persons))} de las personas que escribieron llegaron por un anuncio (${formatCount(fromAds)} de ${formatCount(att.persons)}).`,
    });
  }

  // La IA sale de M4 de Agente (por sesión); el asesor, de `advisorFirstReply`:
  // M4 solo mide al humano cuando respondió ANTES que la IA, y con la IA
  // activa eso casi nunca pasa — para dirección engañaría.
  {
    const parts: string[] = [];
    const ai = report.responseTimes.ok ? report.responseTimes.data.ai : null;
    if (ai && ai.sessions > 0) parts.push(`IA ${formatDuration(ai.p50Seconds)}`);
    const adv = att?.advisorFirstReply;
    if (adv && adv.persons > 0) {
      parts.push(
        `un asesor atendió en ${formatDuration(adv.p50Seconds)} (mediana, ${adv.persons === 1 ? "1 persona" : `${formatCount(adv.persons)} personas`})`
      );
    }
    if (parts.length) {
      out.push({
        key: "response",
        text: `Primera respuesta (mediana): ${parts.join(" · ")}.`,
        agentLink: true,
      });
    }
  }

  if (att && att.outbound > 0) {
    const o = att.outboundByOrigin;
    out.push({
      key: "outbound",
      text: `Se enviaron ${formatCount(att.outbound)} mensajes: ${formatCount(o.ai)} de la IA, ${formatCount(o.advisor)} de asesores y ${formatCount(o.template)} plantillas.`,
    });
  }
  if (att && att.handedOff > 0) {
    out.push({
      key: "handoff",
      text: `${att.handedOff === 1 ? "1 conversación pasó" : `${formatCount(att.handedOff)} conversaciones pasaron`} de la IA a un asesor.`,
    });
  }

  if (report.pending.ok && report.pending.data.total > 0) {
    const t = report.pending.data.total;
    out.push({
      key: "pending",
      text: `${t === 1 ? "1 persona espera" : `${formatCount(t)} personas esperan`} respuesta al generar el reporte.`,
    });
  }

  if (report.sales.ok && report.sales.data.won > 0) {
    const s = report.sales.data;
    out.push({
      key: "sales",
      text: `${s.won === 1 ? "1 venta" : `${formatCount(s.won)} ventas`} por ${formatWonAmount(s.wonAmount)}${s.closeRate !== null ? ` (cierre ${formatPercent(s.closeRate)})` : ""}.`,
    });
  }
  return out;
}
