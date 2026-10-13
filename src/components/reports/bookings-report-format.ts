/**
 * 10 — Reportes → Citas: cómo la pantalla interpreta `GET /api/reports/bookings`
 * y arma sus cifras. Lógica pura (sin React) para probarla en unit.
 *
 * Mismos estados que Reportes → Agente (`report-fetch.ts`), más `soon`: el
 * 501 del contrato 10-0 mientras el servidor no calcula el reporte.
 */

import type {
  AttendanceSliceDto,
  BookingAttendanceDto,
  BookingReportDto,
  OfferConversionDto,
} from "@/lib/reports";
import { formatCount, formatDayLong, formatPercent } from "./format";

export type BookingReportOutcome =
  | { kind: "ok"; report: BookingReportDto }
  | { kind: "timeout" }
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  /** 501 `not_implemented`: «Disponible pronto». */
  | { kind: "soon" }
  | { kind: "error" };

export const BOOKING_REPORT_SOON_MESSAGE =
  "Disponible pronto: esta instancia todavía no calcula el reporte de citas.";

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

function looksLikeBookingReport(body: unknown): body is BookingReportDto {
  if (!body || typeof body !== "object") return false;
  const r = body as Partial<BookingReportDto>;
  return (
    !!r.range &&
    typeof r.range === "object" &&
    typeof r.range.tz === "string" &&
    !!r.offers &&
    !!r.attendance &&
    !!r.byReminder
  );
}

export function classifyBookingReportResponse(
  status: number,
  body: unknown
): BookingReportOutcome {
  if (status === 501) return { kind: "soon" };
  if (status === 503) return { kind: "timeout" };
  if (status === 422) {
    return {
      kind: "invalid",
      message: errorMessage(body) ?? "El rango de fechas no es válido.",
    };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403 || status === 404) return { kind: "forbidden" };
  if (status >= 200 && status < 300 && looksLikeBookingReport(body)) {
    return { kind: "ok", report: body };
  }
  return { kind: "error" };
}

/**
 * ¿El rango está vacío? Solo se afirma con bloques que sí llegaron: sin
 * ofertas ni citas marcadas, pendientes o canceladas.
 */
export function isBookingReportEmpty(report: BookingReportDto): boolean {
  if (!report.offers.ok || !report.attendance.ok) return false;
  const o = report.offers.data;
  const a = report.attendance.data;
  return (
    o.conversationsWithOffer === 0 &&
    a.realizada + a.noShow + a.pendingToMark + a.cancelada === 0
  );
}

/** «4 de 10 conversaciones». */
export function offerDetail(o: OfferConversionDto): string {
  return `${formatCount(o.converted)} de ${formatCount(o.conversationsWithOffer)} conversaciones`;
}

/** Citas marcadas (realizada + no-show). */
export function markedCount(s: AttendanceSliceDto): number {
  return s.realizada + s.noShow;
}

/** «3 de 4 citas marcadas» (o «Ninguna cita marcada»). */
export function attendanceDetail(s: AttendanceSliceDto): string {
  const marked = markedCount(s);
  if (marked === 0) return "Ninguna cita marcada";
  return `${formatCount(s.realizada)} de ${formatCount(marked)} ${marked === 1 ? "cita marcada" : "citas marcadas"}`;
}

/** Tasa de asistencia legible («75 %» o «—»). */
export function attendanceRateLabel(s: AttendanceSliceDto): string {
  return formatPercent(s.rate);
}

/** «2 pendientes de marcar» / «Nada pendiente de marcar». */
export function pendingToMarkLabel(a: BookingAttendanceDto): string {
  if (a.pendingToMark === 0) return "Nada pendiente de marcar";
  return a.pendingToMark === 1
    ? "1 cita pasada sin marcar"
    : `${formatCount(a.pendingToMark)} citas pasadas sin marcar`;
}

/**
 * Aviso sobre el registro de ofertas (empieza con la migración 0018): sin
 * fila todavía, o con su primera fecha en la zona del negocio.
 */
export function offerDataSinceNote(dataSince: string | null, timeZone: string): string {
  if (!dataSince) {
    return "Las ofertas de horario se registran desde esta versión; todavía no hay ninguna.";
  }
  const date = new Date(dataSince);
  if (Number.isNaN(date.getTime())) return "Las ofertas se registran desde esta versión.";
  let day: string;
  try {
    day = date.toLocaleDateString("en-CA", { timeZone });
  } catch {
    day = date.toISOString().slice(0, 10);
  }
  return `Ofertas registradas desde el ${formatDayLong(day)}: antes de esa fecha no hay datos.`;
}
