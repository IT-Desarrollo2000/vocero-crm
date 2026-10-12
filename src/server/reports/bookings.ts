import type { BookingReportDto } from "@/lib/reports";
import type { ReportRange } from "@/server/reports/range";
import { ReminderNotImplementedError } from "@/server/agenda/reminders";

/**
 * 10 — Reportes → Citas (RF-10-15, «Contrato 10-0»). Mismo marco que el
 * reporte del agente (02): `parseReportRange` + `reportTimezone` en la ruta,
 * y aquí `runBlocks` + `runReadOnly` (`src/server/reports/run.ts`) con un
 * bloque por métrica (`offers`, `attendance`, `byReminder`), cada uno con su
 * transacción de solo lectura y su tope por consulta.
 *
 * Reglas para 10-A:
 *  - Excluir SIEMPRE `is_test` (citas y bitácora de ofertas) y `kind='block'`.
 *  - Los límites `[range.fromUtc, range.toUtc)` y `now` viajan como
 *    parámetros; nada de `now()` en SQL (columnas `timestamp` sin zona).
 *  - Toda consulta filtrada por `organization_id` (`scoped`).
 *
 * ESTADO: contrato; la ruta traduce `ReminderNotImplementedError` a 501.
 */
export async function bookingReport(
  organizationId: string,
  range: ReportRange,
  now: Date
): Promise<BookingReportDto> {
  void organizationId;
  void range;
  void now;
  throw new ReminderNotImplementedError("bookingReport");
}
