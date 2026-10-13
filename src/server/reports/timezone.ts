import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isValidTimeZone } from "@/lib/time/slots";

/**
 * 02 — Zona horaria de los reportes (D-02-2): la de la agenda
 * (`calendar_settings.timezone`) si la organización la tiene, si no
 * `America/Mexico_City`. Sin migración; mover la zona a Ajustes → Marca es
 * la opción de largo plazo (D-02-2 c).
 */

export const DEFAULT_REPORT_TIMEZONE = "America/Mexico_City";

/** Zona válida para el runtime, o el default (nunca lanza). */
export function resolveReportTimezone(raw: string | null | undefined): string {
  const tz = raw?.trim();
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_REPORT_TIMEZONE;
}

/** Zona del negocio para los cortes de día de los reportes. */
export async function reportTimezone(organizationId: string): Promise<string> {
  const rows = await getDb()
    .select({ timezone: schema.calendarSettings.timezone })
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  return resolveReportTimezone(rows[0]?.timezone);
}
