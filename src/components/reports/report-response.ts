/**
 * 021 — Cómo una pestaña de Reportes interpreta la respuesta de su
 * `GET /api/reports/<pestaña>`. Los mismos estados que Agente
 * (`report-fetch.ts`) y Anuncios (`ads-report-format.ts`), pero genérico:
 * Ventas y Resumen solo difieren en qué bloques exigen. Lógica pura (sin
 * React) para probarla en unit.
 */

import type { ReportRangeDto } from "@/lib/reports";

export type BlocksReportOutcome<T> =
  | { kind: "ok"; report: T }
  /** 503 `report_timeout`. */
  | { kind: "timeout" }
  /** 422 `invalid_range`. */
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "error" };

export type BlocksReportFailure<T> = Exclude<BlocksReportOutcome<T>, { kind: "ok" }>;

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

/**
 * `status` HTTP + cuerpo ya parseado. Un 200 sin `range` o sin alguno de los
 * bloques exigidos se trata como error (servidor viejo o cuerpo raro): mejor
 * «No se pudo cargar» que una pantalla a medias que parezca vacía.
 */
export function classifyBlocksReport<T extends { range: ReportRangeDto }>(
  status: number,
  body: unknown,
  blocks: readonly (keyof T & string)[]
): BlocksReportOutcome<T> {
  if (status === 503) return { kind: "timeout" };
  if (status === 422) {
    return {
      kind: "invalid",
      message: errorMessage(body) ?? "El rango de fechas no es válido.",
    };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403 || status === 404) return { kind: "forbidden" };
  if (status >= 200 && status < 300 && body && typeof body === "object") {
    const r = body as Record<string, unknown>;
    const range = r.range as Partial<ReportRangeDto> | undefined;
    const okRange =
      !!range && typeof range === "object" && typeof range.tz === "string" && Array.isArray(range.days);
    if (okRange && blocks.every((b) => !!r[b] && typeof r[b] === "object")) {
      return { kind: "ok", report: body as T };
    }
  }
  return { kind: "error" };
}
