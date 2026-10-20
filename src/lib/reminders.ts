/**
 * 10 — Recordatorios de cita: contrato compartido cliente/servidor
 * (dev-tasks/10-recordatorio-de-citas-y-no-shows.md, «Contrato 10-0»).
 *
 * Catálogos, constantes de tiempo, la regla PURA de elegibilidad y los DTOs.
 * Sin dependencias de servidor: lo importan el esquema (`lib/db/schema.ts`),
 * el ticker (`src/server/agenda/reminders.ts`) y la UI (Citas y Ajustes), así
 * que los tres miran la MISMA definición de «cuándo sale un recordatorio».
 */

// ── Estados y motivos ────────────────────────────────────────────────────

/**
 * Estado de `booking_reminder.status`:
 *
 * - `pending`  — NO se escribe en BD en la fase 1: el claim inserta ya en
 *                `sending`. Lo SINTETIZA el DTO para una anticipación
 *                configurada que todavía no tiene fila (con su `dueAt`).
 * - `sending`  — reclamado, envío en curso. Si pasa más de
 *                `REMINDER_STUCK_AFTER_MS` así, `recoverStuckReminders` lo
 *                pasa a `failed` con `error = 'interrumpido'` (no se reenvía
 *                solo: a lo sumo una vez, D-10-02).
 * - `sent`     — Meta aceptó el envío (`message_id`, `sent_at`). La entrega
 *                (delivered/read/failed) se lee del `message` enlazado.
 * - `failed`   — el envío falló (`error`). Reintentable a mano UNA vez.
 * - `skipped`  — no se intentó por un motivo de configuración (`reason`).
 */
export const BOOKING_REMINDER_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "skipped",
] as const;
export type BookingReminderStatus = (typeof BOOKING_REMINDER_STATUSES)[number];

/** Motivo de `skipped` (RF-10-09). Ninguno se reintenta solo. */
export const BOOKING_REMINDER_SKIP_REASONS = [
  /** La plantilla del ajuste ya no está `approved` (p. ej. tras un sync). */
  "template_not_approved",
  /** El ajuste se quedó sin plantilla (borrada → `ON DELETE SET NULL`). */
  "template_missing",
  /** Contacto de Instagram/Messenger: no hay plantillas fuera de WhatsApp. */
  "channel_not_whatsapp",
  /** Sin número de WhatsApp conectado. */
  "not_connected",
  /** El token expiró: hay que reconectar el número. */
  "reconnect_required",
  /** El contacto no tiene teléfono ni BSUID utilizable. */
  "no_recipient",
] as const;
export type BookingReminderSkipReason =
  (typeof BOOKING_REMINDER_SKIP_REASONS)[number];

/** `error` de una fila `sending` rescatada por `recoverStuckReminders`. */
export const REMINDER_INTERRUPTED_ERROR = "interrumpido";

/** Estado de entrega de Meta (`message.status`), leído por join. */
export type ReminderDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

// ── Variables de la plantilla (D-10-03) ──────────────────────────────────

/** Catálogo CERRADO de campos que se pueden mapear a cada `{{n}}`. */
export const REMINDER_FIELDS = [
  "contact_name",
  "booking_datetime",
  "meeting_link",
  "business_name",
  // 023 (A8) — agenda presencial. Al FINAL: el índice de cada campo no importa
  // (el mapeo guarda nombres), pero el orden del selector sí se conserva.
  "appointment_type",
  "address",
] as const;
export type ReminderField = (typeof REMINDER_FIELDS)[number];

export const REMINDER_FIELD_LABEL: Record<ReminderField, string> = {
  contact_name: "Nombre del contacto",
  booking_datetime: "Fecha y hora de la cita",
  meeting_link: "Enlace de la reunión",
  business_name: "Nombre del negocio",
  appointment_type: "Tipo de cita",
  address: "Dirección del negocio",
};

/** `meeting_link` sin enlace: Meta rechaza parámetros vacíos (132000). */
export const MEETING_LINK_FALLBACK = "te lo compartimos por este medio";
/** 023 — `appointment_type` de una cita sin tipo (015). */
export const APPOINTMENT_TYPE_FALLBACK = "tu cita";
/** 023 — `address` sin dirección configurada. */
export const ADDRESS_FALLBACK = "nuestra sucursal";

// ── Anticipaciones ───────────────────────────────────────────────────────

export const DEFAULT_REMINDER_OFFSETS_MINUTES: readonly number[] = [1440];
/** Cada anticipación: de 1 h a 3 días. */
export const REMINDER_OFFSET_LIMITS = { min: 60, max: 4320 } as const;
/** 1 o 2 anticipaciones; también es el tope duro de `sent` por cita y hora. */
export const REMINDER_MAX_OFFSETS = 2;

// ── Reloj (todas las comparaciones las hace JS con `now` inyectado) ──────

/** Una fila `sending` más vieja que esto → `failed / interrumpido`. */
export const REMINDER_STUCK_AFTER_MS = 10 * 60_000;
/** Nunca se envía si faltan menos de 15 min para la cita. */
export const REMINDER_MIN_LEAD_MS = 15 * 60_000;
/** Tope del periodo de gracia, cualquiera que sea la anticipación. */
export const REMINDER_MAX_GRACE_MS = 6 * 60 * 60_000;
/** Recordatorios procesados por organización y vuelta (en serie). */
export const REMINDER_TICK_BATCH = 50;
/** Periodo por defecto del ticker in-process (`AGENDA_REMINDER_TICK_MS`). */
export const REMINDER_TICK_DEFAULT_MS = 60_000;
/** Reintentos manuales permitidos por recordatorio (D-10-02). */
export const REMINDER_MAX_MANUAL_RETRIES = 1;

/** Gracia tras vencer: `min(offset / 4, 6 h)` (24 h → 6 h; 2 h → 30 min). */
export function reminderGraceMs(offsetMinutes: number): number {
  return Math.min((offsetMinutes * 60_000) / 4, REMINDER_MAX_GRACE_MS);
}

/** Momento de envío: `scheduled_at − offset`. */
export function reminderDueAt(scheduledAt: Date, offsetMinutes: number): Date {
  return new Date(scheduledAt.getTime() - offsetMinutes * 60_000);
}

export type ReminderTimingInput = {
  scheduledAt: Date;
  bookingCreatedAt: Date;
  offsetMinutes: number;
  /** `calendar_settings.reminder_enabled_at`; null = nunca se encendió. */
  enabledAt: Date | null;
};

/**
 * Motivo por el que una anticipación NO toca ahora (o `null` si sí toca).
 * Solo la parte de RELOJ de RF-10-04; el estado de la cita, `is_test`, el
 * ajuste encendido y la existencia de fila los filtra la consulta.
 */
export type ReminderTimingVerdict =
  | null
  | "not_enabled"
  | "before_enabled"
  | "before_created"
  | "not_due"
  | "grace_expired"
  | "too_close";

export function reminderTiming(
  input: ReminderTimingInput,
  now: Date
): ReminderTimingVerdict {
  if (!input.enabledAt) return "not_enabled";
  const due = reminderDueAt(input.scheduledAt, input.offsetMinutes).getTime();
  // Encender no dispara una ráfaga sobre lo ya agendado.
  if (due < input.enabledAt.getTime()) return "before_enabled";
  // La cita no existía cuando tocaba (creada dentro de la ventana).
  if (due < input.bookingCreatedAt.getTime()) return "before_created";
  const t = now.getTime();
  if (t < due) return "not_due";
  if (t - due > reminderGraceMs(input.offsetMinutes)) return "grace_expired";
  if (t > input.scheduledAt.getTime() - REMINDER_MIN_LEAD_MS) return "too_close";
  return null;
}

// ── DTOs ─────────────────────────────────────────────────────────────────

/**
 * Un recordatorio dentro de `BookingListItem.reminders` (aditivo). Solo los
 * de la hora VIGENTE de la cita (`scheduled_for = scheduled_at`), uno por
 * anticipación configurada, en orden de anticipación descendente.
 */
export type BookingReminderDto = {
  /** null = sintetizado (`pending`, todavía sin fila). */
  id: string | null;
  offsetMinutes: number;
  /** Hora de la cita a la que corresponde (ISO-8601 UTC). */
  scheduledFor: string;
  /** Momento de envío, `scheduledFor − offset` (ISO-8601 UTC). */
  dueAt: string;
  status: BookingReminderStatus;
  reason: BookingReminderSkipReason | null;
  error: string | null;
  sentAt: string | null;
  attempts: number;
  /** `failed`, cita `agendada` y futura, y quedan reintentos manuales. */
  canRetry: boolean;
  /** Estado de entrega del `message` enlazado; null sin mensaje. */
  delivery: ReminderDeliveryStatus | null;
  /** `message.error` cuando Meta reporta la entrega fallida. */
  deliveryError: string | null;
};

/** La plantilla elegida, resumida para Ajustes. */
export type ReminderTemplateSummaryDto = {
  id: string;
  name: string;
  language: string;
  /** Categoría REAL (Meta puede reclasificar UTILITY → MARKETING). */
  category: string;
  status: "draft" | "pending" | "approved" | "rejected";
  variableCount: number;
};

/** `reminders` (hermano de `settings`) en GET/PUT `/api/calendar/settings`. */
export type ReminderSettingsDto = {
  enabled: boolean;
  /** ISO-8601; solo se avisan recordatorios con `dueAt ≥ enabledAt`. */
  enabledAt: string | null;
  templateId: string | null;
  template: ReminderTemplateSummaryDto | null;
  offsetsMinutes: number[];
  /** Índice = `{{n}} − 1`. */
  variables: ReminderField[];
  /**
   * Aviso para Ajustes: encendido pero la plantilla ya no sirve (los
   * recordatorios saldrán `skipped` con ese motivo).
   */
  warning: "template_missing" | "template_not_approved" | null;
};

/**
 * Campos de recordatorio que acepta `PUT /api/calendar/settings` (todos
 * opcionales, junto a los de la agenda). Guardar con `reminderEnabled=true`
 * exige plantilla `approved` de WhatsApp y un campo por CADA `{{n}}`
 * (422 `invalid_body` con mensaje si no).
 */
export type ReminderSettingsInput = {
  reminderEnabled?: boolean;
  reminderTemplateId?: string | null;
  reminderOffsetsMinutes?: number[];
  reminderVariables?: ReminderField[];
};

export const REMINDER_SETTINGS_INPUT_KEYS = [
  "reminderEnabled",
  "reminderTemplateId",
  "reminderOffsetsMinutes",
  "reminderVariables",
] as const satisfies readonly (keyof ReminderSettingsInput)[];

/** Respuesta 200 de `POST /api/bookings/[id]/reminders/[reminderId]/retry`. */
export type ReminderRetryResultDto = {
  ok: true;
  reminder: BookingReminderDto;
};

/** Respuesta 200 de `POST /api/dev/reminders/tick` (= resultado del tick). */
export type ReminderTickResultDto = {
  /** `now` usado (ISO-8601). */
  now: string;
  organizations: number;
  /** Filas `sending` rescatadas a `failed / interrumpido`. */
  recovered: number;
  /** Filas insertadas (claims ganados). Un claim perdido no cuenta. */
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
};
