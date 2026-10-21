/**
 * 021 — Reportes → Resumen para dirección: cómo la pantalla arma sus cifras
 * y la «lectura rápida» a partir de `GET /api/reports/summary`. Lógica pura
 * (sin React) para probarla en unit. Semántica en `src/lib/reports.ts`
 * (plan 021 §3.2 y §6, extensión 021b).
 */

import type {
  BookingCountsDto,
  ReportRangeDto,
  SummaryAdOriginRowDto,
  SummaryOriginFiguresDto,
  SummaryReportDto,
} from "@/lib/reports";
import { formatCount, formatDuration, formatPercent, ratio } from "./format";
import { formatWonAmount } from "./ads-report-format";

/** Bloques que un 200 de `/api/reports/summary` debe traer. */
export const SUMMARY_BLOCKS = [
  "attention",
  "byOrigin",
  "external",
  "byChannel",
  "byHour",
  "pending",
  "sales",
  "responseTimes",
  // 024 — «Equipo». `bookings` NO: es null sin AGENDA.
  "team",
] as const satisfies readonly (keyof SummaryReportDto)[];

/**
 * ¿Nadie escribió ni llegó ningún lead en el rango? Solo se afirma si el
 * bloque de atención llegó (un rango con solo tarjetas de leads externos NO
 * está vacío).
 */
export function isSummaryReportEmpty(report: SummaryReportDto): boolean {
  if (!report.attention.ok) return false;
  const a = report.attention.data;
  return a.persons === 0 && a.inbound === 0 && a.leads === 0;
}

/**
 * ¿Se enseñan las filas/secciones de leads externos (Sitio web, FastApp)?
 * Con la bandera encendida, siempre; apagada, solo si hay datos (de cuando
 * estuvo encendida). Apagada y sin datos, la UI no los menciona (ADR-001).
 */
export function showExternalOrigins(report: SummaryReportDto): boolean {
  if (report.intakeEnabled) return true;
  const o = report.byOrigin.ok ? report.byOrigin.data : null;
  const has = (f: SummaryOriginFiguresDto | undefined) => !!f && (f.leads > 0 || f.won > 0);
  const ext = report.external.ok ? report.external.data.rows : [];
  return has(o?.website) || has(o?.fastApp) || ext.some((r) => r.received > 0);
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
export function adRowLabels(rows: readonly SummaryAdOriginRowDto[]): Map<string, AdRowLabel> {
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
 * Fila «Total» de «Por origen». Los anuncios se cortan en 50, así que NO se
 * suman las filas visibles: el servidor manda `totals`, la suma de TODOS los
 * grupos del rango (cada lead está en exactamente un origen).
 */
export function originTotals(report: SummaryReportDto): SummaryOriginFiguresDto | null {
  return report.byOrigin.ok ? report.byOrigin.data.totals : null;
}

export type Highlight = {
  key: string;
  text: string;
  agentLink?: boolean;
  /** 024 — enlace «ver Vendedores» (solo en pantalla). */
  sellersLink?: boolean;
};

/** «3 leads» / «1 lead». */
function leadsText(n: number): string {
  return n === 1 ? "1 lead" : `${formatCount(n)} leads`;
}

/**
 * «Lectura rápida»: las 3–5 frases que dirección lee antes que las tablas.
 * Cada una sale de un bloque; si el bloque falló, la frase no aparece.
 */
export function summaryHighlights(report: SummaryReportDto): Highlight[] {
  const out: Highlight[] = [];
  const att = report.attention.ok ? report.attention.data : null;

  if (report.byOrigin.ok && report.byOrigin.data.totals.leads > 0) {
    // Los anuncios = todo lo que no es sitio web, FastApp ni sin origen (las
    // filas de anuncio vienen cortadas en 50; `totals` no).
    const o = report.byOrigin.data;
    const total = o.totals.leads;
    const fromAds = Math.max(0, total - o.website.leads - o.fastApp.leads - o.unidentified.leads);
    const ext = [
      o.website.leads > 0 ? `${formatCount(o.website.leads)} por el sitio web` : null,
      o.fastApp.leads > 0 ? `${formatCount(o.fastApp.leads)} por FastApp` : null,
    ].filter(Boolean);
    out.push({
      key: "ads",
      text: `${formatPercent(ratio(fromAds, total))} de los leads del rango llegaron por un anuncio (${formatCount(fromAds)} de ${formatCount(total)})${ext.length ? `; ${ext.join(" y ")}` : ""}.`,
    });
  }

  if (report.external.ok) {
    const rows = report.external.data.rows;
    const pending = rows.reduce((a, r) => a + r.notContacted, 0);
    if (pending > 0) {
      const parts = rows
        .filter((r) => r.notContacted > 0)
        .map((r) => `${formatCount(r.notContacted)} ${r.origin === "website" ? "del sitio web" : "de FastApp"}`);
      out.push({
        key: "external",
        text: `${leadsText(pending)} del formulario y FastApp ${pending === 1 ? "sigue" : "siguen"} sin contactar (${parts.join(", ")}).`,
      });
    }
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

  // 024 — Un vendedor concentra los pendientes: solo si hay al menos
  // `TEAM_PENDING_MIN` y él tiene `TEAM_PENDING_SHARE` o más.
  {
    const top = teamPendingHighlight(report);
    if (top) out.push({ key: "team-pending", text: top, sellersLink: true });
  }

  if (report.sales.ok && report.sales.data.won > 0) {
    const s = report.sales.data;
    out.push({
      key: "sales",
      text: `${s.won === 1 ? "1 venta" : `${formatCount(s.won)} ventas`} por ${formatWonAmount(s.wonAmount)}${s.closeRate !== null ? ` (cierre ${formatPercent(s.closeRate)})` : ""}.`,
    });
  }
  // 024 — Citas del periodo (solo con AGENDA y si hubo alguna).
  if (report.agendaEnabled && report.bookings?.ok && report.bookings.data.total > 0) {
    out.push({ key: "bookings", text: bookingsPeriodText(report.bookings.data) });
  }
  return out;
}

/** Mínimo de pendientes para hablar de concentración (con 2 no es noticia). */
export const TEAM_PENDING_MIN = 3;
/** Parte de los pendientes que un vendedor debe concentrar para la viñeta. */
export const TEAM_PENDING_SHARE = 0.4;

/** «Ericka tiene 18 de 33 pendientes.» o null si nadie los concentra. */
export function teamPendingHighlight(report: SummaryReportDto): string | null {
  if (!report.team.ok) return null;
  const top = report.team.data.topPending;
  if (!top || top.ofTotal < TEAM_PENDING_MIN || top.pending <= 0) return null;
  if (top.pending / top.ofTotal < TEAM_PENDING_SHARE) return null;
  return `${top.name} tiene ${formatCount(top.pending)} de ${formatCount(top.ofTotal)} pendientes de respuesta (según la asignación actual).`;
}

/** «Citas del periodo: 6 agendadas · 3 realizadas · asistencia 75 %.» */
export function bookingsPeriodText(b: BookingCountsDto): string {
  return `Citas del periodo: ${formatCount(b.total)} ${b.total === 1 ? "agendada" : "agendadas"} · ${formatCount(b.realizada)} ${b.realizada === 1 ? "realizada" : "realizadas"} · asistencia ${formatPercent(b.rate)}.`;
}
