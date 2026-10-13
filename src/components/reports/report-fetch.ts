/**
 * 02 — Cómo la pantalla interpreta la respuesta de `GET /api/reports/agent`.
 * Lógica pura (sin React) para poder probarla en unit.
 */

import type { AgentReportDto } from "./types";

export type ReportOutcome =
  | { kind: "ok"; report: AgentReportDto }
  /** 503 `report_timeout`: la consulta pasó de 15 s (RF-02-08). */
  | { kind: "timeout" }
  /** 422 `invalid_range`. */
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "error" };

export const TIMEOUT_MESSAGE =
  "El reporte tardó demasiado; prueba un rango menor.";

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

function looksLikeReport(body: unknown): body is AgentReportDto {
  if (!body || typeof body !== "object") return false;
  const r = body as Partial<AgentReportDto>;
  return (
    !!r.range &&
    typeof r.range === "object" &&
    Array.isArray(r.range.days) &&
    typeof r.range.tz === "string"
  );
}

/** `status` HTTP + cuerpo ya parseado (o null si no era JSON). */
export function classifyReportResponse(status: number, body: unknown): ReportOutcome {
  if (status === 503) return { kind: "timeout" };
  if (status === 422) {
    return {
      kind: "invalid",
      message: errorMessage(body) ?? "El rango de fechas no es válido.",
    };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403 || status === 404) return { kind: "forbidden" };
  if (status >= 200 && status < 300 && looksLikeReport(body)) {
    return { kind: "ok", report: body };
  }
  return { kind: "error" };
}

/**
 * ¿El rango está vacío? (CA-02-07). Solo se afirma con los bloques que sí
 * llegaron: si el reparto falló no se sabe, y no se dice «no hay datos».
 */
export function isReportEmpty(report: AgentReportDto): boolean {
  if (!report.attention.ok) return false;
  if (report.attention.data.active > 0) return false;
  if (report.volume.ok && report.volume.data.rows.some((r) => r.inbound + r.outbound > 0)) {
    return false;
  }
  return true;
}
