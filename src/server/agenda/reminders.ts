import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  REMINDER_FIELDS,
  type ReminderField,
  type ReminderSettingsDto,
  type ReminderTickResultDto,
  type BookingReminderDto,
} from "@/lib/reminders";
import { countVariables } from "@/lib/templates";

/**
 * 10 — Recordatorios de cita (dev-tasks/10-recordatorio-de-citas-y-no-shows.md,
 * «Contrato 10-0»). Detrás de la bandera AGENDA: con ella apagada el ticker no
 * arranca y las rutas responden 404 antes de llegar aquí.
 *
 * ESTADO: contrato. Las firmas son definitivas; los cuerpos marcados
 * `notImplemented` los completa 10-A. Lo que ya es real: las constantes y la
 * regla de reloj (re-exportadas de `src/lib/reminders.ts`) y la lectura de los
 * ajustes (`getReminderSettings`).
 *
 * Reloj INYECTABLE: toda función de la lógica recibe `now: Date` y es ella la
 * que escribe `claimed_at`/`sent_at`/`updated_at` con ese valor. Nada de
 * `DEFAULT now()` ni `now()` de SQL en la lógica — así un test prueba
 * "interrumpido a los 10 min" llamando con `now + 11 min`, sin esperar.
 *
 * Reglas que 10-A debe cumplir (ver el .md para el detalle):
 *  - Sandbox: la consulta de candidatos filtra `booking.is_test = false`
 *    (sin fila jamás), y `sendTemplate` lanza `SendError("sandbox_violation")`
 *    como segunda barrera. No se "arregla" esa excepción.
 *  - Cancelar o marcar `realizada`/`no_show` saca la cita de la consulta
 *    (`status = 'agendada'`): no se envía nada después.
 *  - Reprogramar cambia `scheduled_at` ⇒ la clave `(booking, offset,
 *    scheduled_for)` es otra ⇒ recordatorios nuevos; los viejos son historial.
 *  - Sin `booking.conversation_id`: conversación real del contacto o
 *    `getOrCreateConversation` (`src/server/inbox/ingest.ts`).
 *  - Cada cambio de fila publica `booking.updated` por SSE.
 *  - Nunca relanza hacia la agenda: crear/reprogramar/cancelar no dependen de
 *    nada de esto (RF-10-16).
 */

export {
  REMINDER_MAX_GRACE_MS,
  REMINDER_MAX_MANUAL_RETRIES,
  REMINDER_MIN_LEAD_MS,
  REMINDER_STUCK_AFTER_MS,
  REMINDER_TICK_BATCH,
  REMINDER_TICK_DEFAULT_MS,
  reminderDueAt,
  reminderGraceMs,
  reminderTiming,
} from "@/lib/reminders";

/** Lo que aún no implementa 10-A. Las rutas lo traducen a 501. */
export class ReminderNotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: pendiente (tarea 10-A)`);
    this.name = "ReminderNotImplementedError";
  }
}

function notImplemented(what: string): never {
  throw new ReminderNotImplementedError(what);
}

/** Errores de dominio del reintento manual → HTTP en `reminderErrorStatus`. */
export class ReminderError extends Error {
  code:
    /** El recordatorio no existe, es de otra organización o de otra cita. */
    | "not_found"
    /** No está `failed` (otro reintento lo ganó, o ya salió). */
    | "not_retryable"
    /** Ya se usó el único reintento manual (D-10-02). */
    | "retry_exhausted"
    /** La cita ya no está `agendada`, o su hora ya pasó. */
    | "booking_not_active";

  constructor(code: ReminderError["code"], message: string) {
    super(message);
    this.name = "ReminderError";
    this.code = code;
  }
}

export function reminderErrorStatus(code: ReminderError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "not_retryable":
    case "retry_exhausted":
    case "booking_not_active":
      return 409;
  }
}

/**
 * Una vuelta completa: organizaciones con `reminder_enabled = true` → por
 * cada una, `recoverStuckReminders`, candidatos (RF-10-04 con
 * `reminderTiming`), claim por `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * (estado inicial `sending`, `claimed_at = now`), envío en serie con tope
 * `REMINDER_TICK_BATCH`. Nunca lanza por un recordatorio: cada fallo queda en
 * su fila.
 *
 * La ruta dev `POST /api/dev/reminders/tick` la llama DIRECTO (sin el ticker
 * ni su `inFlight`), para que dos POST paralelos ejerciten el UNIQUE.
 */
export async function runReminderTick(now: Date): Promise<ReminderTickResultDto> {
  void now;
  return notImplemented("runReminderTick");
}

/**
 * Filas `sending` con `claimed_at < now − REMINDER_STUCK_AFTER_MS` →
 * `failed`, `error = 'interrumpido'`, `updated_at = now`. No reenvía.
 * Sin `organizationId`: todas las organizaciones (lo usa el tick).
 * Devuelve cuántas rescató.
 */
export async function recoverStuckReminders(
  now: Date,
  organizationId?: string
): Promise<number> {
  void now;
  void organizationId;
  return notImplemented("recoverStuckReminders");
}

/**
 * Reintento manual (D-10-02): claim condicionado `UPDATE … SET status =
 * 'sending', attempts = attempts + 1, claimed_at = now WHERE id = ? AND
 * booking_id = ? AND status = 'failed' AND attempts <= REMINDER_MAX_MANUAL_RETRIES
 * RETURNING`, solo si la cita sigue `agendada` y faltan ≥
 * `REMINDER_MIN_LEAD_MS`. Reusa la misma fila. Lanza `ReminderError`.
 */
export async function retryReminder(input: {
  organizationId: string;
  bookingId: string;
  reminderId: string;
  now: Date;
}): Promise<BookingReminderDto> {
  void input;
  return notImplemented("retryReminder");
}

/**
 * Recordatorios de la hora VIGENTE de cada cita (`scheduled_for =
 * scheduled_at`), con el estado de entrega del `message` enlazado, más los
 * `pending` sintetizados de las anticipaciones sin fila. Para
 * `listBookings` (aditivo: `BookingListItem.reminders`).
 */
export async function remindersForBookings(
  organizationId: string,
  bookingIds: string[],
  now: Date
): Promise<Map<string, BookingReminderDto[]>> {
  void organizationId;
  void bookingIds;
  void now;
  // Contrato: hasta 10-A, ninguna cita tiene recordatorios que mostrar.
  return new Map();
}

/** Ajustes de recordatorio, con la plantilla elegida resumida. Nunca lanza por datos raros. */
export async function getReminderSettings(
  organizationId: string
): Promise<ReminderSettingsDto> {
  const rows = await getDb()
    .select({
      enabled: schema.calendarSettings.reminderEnabled,
      enabledAt: schema.calendarSettings.reminderEnabledAt,
      templateId: schema.calendarSettings.reminderTemplateId,
      offsets: schema.calendarSettings.reminderOffsetsMinutes,
      variables: schema.calendarSettings.reminderVariables,
      template: schema.template,
    })
    .from(schema.calendarSettings)
    .leftJoin(
      schema.template,
      eq(schema.calendarSettings.reminderTemplateId, schema.template.id)
    )
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_REMINDER_SETTINGS;

  const template =
    row.template && row.template.organizationId === organizationId
      ? {
          id: row.template.id,
          name: row.template.name,
          language: row.template.language,
          category: row.template.category,
          status: row.template.status,
          variableCount: countVariables(row.template.body),
        }
      : null;

  return {
    enabled: row.enabled,
    enabledAt: row.enabledAt?.toISOString() ?? null,
    templateId: template?.id ?? null,
    template,
    offsetsMinutes: normalizeOffsets(row.offsets),
    variables: normalizeVariables(row.variables),
    warning: !row.enabled
      ? null
      : !template
        ? "template_missing"
        : template.status !== "approved"
          ? "template_not_approved"
          : null,
  };
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettingsDto = {
  enabled: false,
  enabledAt: null,
  templateId: null,
  template: null,
  offsetsMinutes: [...DEFAULT_REMINDER_OFFSETS_MINUTES],
  variables: [],
  warning: null,
};

function normalizeOffsets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_REMINDER_OFFSETS_MINUTES];
  const out = raw.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  return out.length > 0 ? out : [...DEFAULT_REMINDER_OFFSETS_MINUTES];
}

/**
 * El índice ES la posición `{{n}}`: filtrar un campo desconocido correría los
 * demás de lugar. Un mapeo con algo fuera del catálogo se descarta entero.
 */
function normalizeVariables(raw: unknown): ReminderField[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.every((v) =>
    (REMINDER_FIELDS as readonly string[]).includes(v as string)
  );
  return valid ? (raw as ReminderField[]) : [];
}
