/**
 * 020 fase B — Reportes → Anuncios: cómo la pantalla interpreta
 * `GET /api/reports/ads` y arma sus cifras. Lógica pura (sin React) para
 * probarla en unit. Mismos estados que Reportes → Agente (`report-fetch.ts`).
 */

import { etiquetaDeOrigen } from "@/lib/anuncios";
import { formatMoneyCents } from "@/lib/money";
import type { AdRowDto, AdsReportDto, WonAmountDto } from "@/lib/reports";
import { EMPTY_VALUE, formatCount } from "./format";

export type AdsReportOutcome =
  | { kind: "ok"; report: AdsReportDto }
  | { kind: "timeout" }
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "error" };

/** Texto de ayuda de la semántica (el mismo que documenta el plan §8.5). */
export const ADS_REPORT_HELP = {
  leads:
    "Un lead entra al rango el día que llegó: el de su primer anuncio si vino por uno, o el de su alta si no. Cada contacto cuenta una vez, con el primer anuncio que lo trajo.",
  won: "Ventas = de esos leads, los que hoy están en una etapa Ganado.",
  amount:
    "Monto = suma de los montos de las ventas, en la moneda del negocio. Una venta sin monto cuenta como venta pero no suma.",
  conversations: "Conversaciones nuevas en el rango (sin el Laboratorio).",
  source:
    "Fuente = la capturada en el contacto; si nadie la capturó, la deducida por su primer origen (anuncio → Anuncio, publicación → Contenido orgánico).",
} as const;

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

function looksLikeAdsReport(body: unknown): body is AdsReportDto {
  if (!body || typeof body !== "object") return false;
  const r = body as Partial<AdsReportDto>;
  return (
    !!r.range &&
    typeof r.range === "object" &&
    typeof r.range.tz === "string" &&
    !!r.summary &&
    !!r.bySource &&
    !!r.byAd
  );
}

export function classifyAdsReportResponse(status: number, body: unknown): AdsReportOutcome {
  if (status === 503) return { kind: "timeout" };
  if (status === 422) {
    return {
      kind: "invalid",
      message: errorMessage(body) ?? "El rango de fechas no es válido.",
    };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403 || status === 404) return { kind: "forbidden" };
  if (status >= 200 && status < 300 && looksLikeAdsReport(body)) {
    return { kind: "ok", report: body };
  }
  return { kind: "error" };
}

/**
 * ¿El rango está vacío? Solo se afirma con el bloque por fuente (que cubre
 * todo): si falló no se sabe, y no se dice «no hay datos».
 */
export function isAdsReportEmpty(report: AdsReportDto): boolean {
  if (!report.bySource.ok) return false;
  return report.bySource.data.rows.every((r) => r.conversations === 0 && r.leads === 0);
}

/**
 * Qué se muestra como monto principal y qué va aparte. Si en la moneda del
 * negocio no hay nada pero sí en otra (p. ej. solo ventas en USD), esa otra
 * pasa a ser la principal: «$0.00 · USD 50.00 aparte» confunde.
 */
function principalYResto(a: WonAmountDto): {
  principal: { currency: string; amountCents: number };
  resto: WonAmountDto["otherCurrencies"];
} {
  const [primera, ...demas] = a.otherCurrencies;
  if (a.amountCents === 0 && primera) return { principal: primera, resto: demas };
  return { principal: a, resto: a.otherCurrencies };
}

/** Monto principal legible («$12,500.00»). */
export function formatWonAmount(a: WonAmountDto): string {
  const { principal } = principalYResto(a);
  return formatMoneyCents(principal.amountCents, principal.currency) ?? EMPTY_VALUE;
}

/**
 * Lo que el monto principal NO incluye, en palabras: otras monedas (aparte,
 * jamás sumadas) y ventas sin monto capturado. `null` si no hay nada que
 * avisar.
 */
export function wonAmountNote(a: WonAmountDto): string | null {
  const parts: string[] = [];
  for (const o of principalYResto(a).resto) {
    parts.push(`${formatMoneyCents(o.amountCents, o.currency) ?? o.currency} aparte`);
  }
  if (a.wonWithoutAmount > 0) {
    parts.push(
      a.wonWithoutAmount === 1
        ? "1 venta sin monto"
        : `${formatCount(a.wonWithoutAmount)} ventas sin monto`
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Variación contra el rango anterior: «+25 %», «−10 %», «igual», «nuevo» (antes
 * 0); `null` si no hay nada que comparar (ambos en 0).
 */
export function formatChange(current: number, previous: number): string | null {
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return "nuevo";
  if (current === previous) return "igual";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "igual";
  return pct > 0 ? `+${pct} %` : `−${Math.abs(pct)} %`;
}

/** «Anuncio · video», «Publicación · imagen», «Anuncio». */
export function adTypeLabel(row: Pick<AdRowDto, "sourceType" | "mediaType">): string {
  const media =
    row.mediaType === "video" ? "video" : row.mediaType === "image" ? "imagen" : null;
  const kind = etiquetaDeOrigen(row.sourceType);
  return media ? `${kind} · ${media}` : kind;
}

/** Ganados del rango sin monto (suma de todas las filas por fuente). */
export function totalWonWithoutAmount(report: AdsReportDto): number {
  if (!report.bySource.ok) return 0;
  return report.bySource.data.rows.reduce((a, r) => a + r.wonAmount.wonWithoutAmount, 0);
}
