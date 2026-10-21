import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeFormality, type Formality } from "@/lib/formality";
import {
  REMINDER_FIELDS,
  REMINDER_MAX_MANUAL_RETRIES,
  REMINDER_MIN_LEAD_MS,
  REMINDER_STUCK_AFTER_MS,
  REMINDER_INTERRUPTED_ERROR,
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  type BookingReminderSkipReason,
  type ReminderDeliveryStatus,
  type ReminderField,
} from "@/lib/reminders";

/**
 * 10 — Acceso a datos de los recordatorios de cita. Separado de la lógica
 * (`reminders.ts`) para que el reloj, el claim y la traducción de errores se
 * prueben con un almacén simulado, y para que cada consulta viva en un solo
 * lugar con su `scoped()`.
 *
 * Reloj INYECTABLE: ninguna consulta usa `now()` de SQL; los instantes
 * (`claimed_at`, `sent_at`, `updated_at`) llegan como parámetro.
 */

export type ReminderOrgConfig = {
  organizationId: string;
  enabled: boolean;
  enabledAt: Date | null;
  templateId: string | null;
  offsetsMinutes: number[];
  variables: ReminderField[];
  /** Zona del negocio (`calendar_settings.timezone`) para `booking_datetime`. */
  timezone: string;
  /** 023 (A8) — `calendar_settings.address` para la variable `address`. */
  address?: string | null;
};

export type ReminderContact = {
  id: string;
  name: string;
  channel: "whatsapp" | "instagram" | "messenger";
  phone: string | null;
  waUserId: string | null;
};

export type ReminderBooking = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  isTest: boolean;
  scheduledAt: Date;
  createdAt: Date;
  conversationId: string | null;
  meetingLink: string | null;
  /** 023 (A8) — Nombre del tipo de cita (null en citas sin tipo). */
  appointmentTypeName?: string | null;
  contact: ReminderContact | null;
};

export type ReminderRow = {
  id: string;
  bookingId: string;
  offsetMinutes: number;
  scheduledFor: Date;
  status: "sending" | "sent" | "failed" | "skipped";
  reason: BookingReminderSkipReason | null;
  error: string | null;
  sentAt: Date | null;
  attempts: number;
  messageId: string | null;
  delivery: ReminderDeliveryStatus | null;
  deliveryError: string | null;
};

export type ReminderTemplate = { id: string; status: string; body: string };

export type ReminderPatch = {
  status: "sent" | "failed" | "skipped";
  reason?: BookingReminderSkipReason | null;
  error?: string | null;
  messageId?: string | null;
  waMessageId?: string | null;
  sentAt?: Date | null;
  templateId?: string | null;
};

/** Tope de citas candidatas leídas por organización y vuelta. */
const CANDIDATE_LIMIT = 500;

/**
 * Organizaciones con recordatorios encendidos. ÚNICA consulta sin tenant del
 * módulo (el ticker no tiene sesión): devuelve solo ids y ajustes; todo lo
 * demás va `scoped()` por organización.
 */
export async function listReminderOrganizations(): Promise<ReminderOrgConfig[]> {
  const rows = await getDb()
    .select(configColumns)
    .from(schema.calendarSettings)
    .where(eq(schema.calendarSettings.reminderEnabled, true));
  return rows.map(toConfig);
}

/** Ajustes de recordatorio de UNA organización (null sin fila de agenda). */
export async function getReminderOrgConfig(
  organizationId: string
): Promise<ReminderOrgConfig | null> {
  const rows = await getDb()
    .select(configColumns)
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toConfig(rows[0]) : null;
}

/**
 * Escribe los 5 campos de recordatorio. Requiere que la fila de
 * `calendar_settings` exista (la ruta llama antes a `upsertSettings`, que la
 * crea): `weekly_hours` es NOT NULL sin default y no se inventa aquí.
 */
export async function saveReminderOrgConfig(
  organizationId: string,
  values: {
    enabled: boolean;
    enabledAt: Date | null;
    templateId: string | null;
    offsetsMinutes: number[];
    variables: ReminderField[];
  },
  now: Date
): Promise<void> {
  await getDb()
    .update(schema.calendarSettings)
    .set({
      reminderEnabled: values.enabled,
      reminderEnabledAt: values.enabledAt,
      reminderTemplateId: values.templateId,
      reminderOffsetsMinutes: values.offsetsMinutes,
      reminderVariables: values.variables,
      updatedAt: now,
    })
    .where(scoped(schema.calendarSettings.organizationId, organizationId));
}

const configColumns = {
  organizationId: schema.calendarSettings.organizationId,
  enabled: schema.calendarSettings.reminderEnabled,
  enabledAt: schema.calendarSettings.reminderEnabledAt,
  templateId: schema.calendarSettings.reminderTemplateId,
  offsets: schema.calendarSettings.reminderOffsetsMinutes,
  variables: schema.calendarSettings.reminderVariables,
  timezone: schema.calendarSettings.timezone,
  address: schema.calendarSettings.address,
};

function toConfig(r: {
  organizationId: string;
  enabled: boolean;
  enabledAt: Date | null;
  templateId: string | null;
  offsets: unknown;
  variables: unknown;
  timezone: string;
  address?: string | null;
}): ReminderOrgConfig {
  return {
    organizationId: r.organizationId,
    enabled: r.enabled,
    enabledAt: r.enabledAt,
    templateId: r.templateId,
    offsetsMinutes: normalizeOffsets(r.offsets),
    variables: normalizeVariables(r.variables),
    timezone: r.timezone,
    address: r.address ?? null,
  };
}

const bookingColumns = {
  id: schema.booking.id,
  kind: schema.booking.kind,
  status: schema.booking.status,
  isTest: schema.booking.isTest,
  scheduledAt: schema.booking.scheduledAt,
  createdAt: schema.booking.createdAt,
  conversationId: schema.booking.conversationId,
  meetingLink: schema.booking.meetingLink,
  appointmentTypeName: schema.appointmentType.name,
  contactId: schema.contact.id,
  contactName: schema.contact.name,
  contactChannel: schema.contact.channel,
  contactPhone: schema.contact.phone,
  contactWaUserId: schema.contact.waUserId,
};

type BookingSelectRow = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  isTest: boolean;
  scheduledAt: Date;
  createdAt: Date;
  conversationId: string | null;
  meetingLink: string | null;
  appointmentTypeName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactChannel: "whatsapp" | "instagram" | "messenger" | null;
  contactPhone: string | null;
  contactWaUserId: string | null;
};

function toBooking(r: BookingSelectRow): ReminderBooking {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    isTest: r.isTest,
    scheduledAt: r.scheduledAt,
    createdAt: r.createdAt,
    conversationId: r.conversationId,
    meetingLink: r.meetingLink,
    appointmentTypeName: r.appointmentTypeName ?? null,
    contact: r.contactId
      ? {
          id: r.contactId,
          name: r.contactName ?? "",
          channel: r.contactChannel ?? "whatsapp",
          phone: r.contactPhone,
          waUserId: r.contactWaUserId,
        }
      : null,
  };
}

/**
 * Citas que PUEDEN tener un recordatorio vencido: sesiones `agendada`, NO de
 * prueba (primera barrera del sandbox: una cita `is_test` jamás genera fila),
 * con la cita entre `now + 15 min` y `now + anticipación mayor`. El reloj fino
 * (gracia, `enabled_at`, `created_at`) lo decide `reminderTiming` en JS.
 */
export async function listCandidateBookings(
  organizationId: string,
  now: Date,
  maxOffsetMinutes: number
): Promise<ReminderBooking[]> {
  const from = new Date(now.getTime() + REMINDER_MIN_LEAD_MS);
  const to = new Date(now.getTime() + maxOffsetMinutes * 60_000);
  const rows = await getDb()
    .select(bookingColumns)
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
    .leftJoin(
      schema.appointmentType,
      eq(schema.booking.appointmentTypeId, schema.appointmentType.id)
    )
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        eq(schema.booking.status, "agendada"),
        eq(schema.booking.isTest, false),
        gte(schema.booking.scheduledAt, from),
        lte(schema.booking.scheduledAt, to)
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(CANDIDATE_LIMIT);
  return rows.map(toBooking);
}

/** Una cita (con su contacto) para el reintento manual o el listado. */
export async function getReminderBooking(
  organizationId: string,
  bookingId: string
): Promise<ReminderBooking | null> {
  const rows = await getDb()
    .select(bookingColumns)
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
    .leftJoin(
      schema.appointmentType,
      eq(schema.booking.appointmentTypeId, schema.appointmentType.id)
    )
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  return rows[0] ? toBooking(rows[0]) : null;
}

/** Citas por id, sin contacto (para sintetizar el DTO del listado). */
export async function getReminderBookings(
  organizationId: string,
  bookingIds: string[]
): Promise<ReminderBooking[]> {
  if (bookingIds.length === 0) return [];
  const rows = await getDb()
    .select(bookingColumns)
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
    .leftJoin(
      schema.appointmentType,
      eq(schema.booking.appointmentTypeId, schema.appointmentType.id)
    )
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        inArray(schema.booking.id, bookingIds)
      )
    );
  return rows.map(toBooking);
}

const rowColumns = {
  id: schema.bookingReminder.id,
  bookingId: schema.bookingReminder.bookingId,
  offsetMinutes: schema.bookingReminder.offsetMinutes,
  scheduledFor: schema.bookingReminder.scheduledFor,
  status: schema.bookingReminder.status,
  reason: schema.bookingReminder.reason,
  error: schema.bookingReminder.error,
  sentAt: schema.bookingReminder.sentAt,
  attempts: schema.bookingReminder.attempts,
  messageId: schema.bookingReminder.messageId,
  delivery: schema.message.status,
  deliveryError: schema.message.error,
};

type RowSelect = {
  id: string;
  bookingId: string;
  offsetMinutes: number;
  scheduledFor: Date;
  status: string;
  reason: BookingReminderSkipReason | null;
  error: string | null;
  sentAt: Date | null;
  attempts: number;
  messageId: string | null;
  delivery: ReminderDeliveryStatus | null;
  deliveryError: string | null;
};

function toRow(r: RowSelect): ReminderRow {
  return {
    ...r,
    // `pending` jamás se escribe en BD; cualquier valor raro se lee como failed.
    status:
      r.status === "sending" ||
      r.status === "sent" ||
      r.status === "failed" ||
      r.status === "skipped"
        ? r.status
        : "failed",
    delivery: r.messageId ? r.delivery : null,
    deliveryError: r.messageId && r.delivery === "failed" ? r.deliveryError : null,
  };
}

/** Filas de recordatorio de esas citas (todas las horas), con la entrega. */
export async function listReminderRows(
  organizationId: string,
  bookingIds: string[]
): Promise<ReminderRow[]> {
  if (bookingIds.length === 0) return [];
  const rows = await getDb()
    .select(rowColumns)
    .from(schema.bookingReminder)
    .leftJoin(
      schema.message,
      eq(schema.bookingReminder.messageId, schema.message.id)
    )
    .where(
      scoped(
        schema.bookingReminder.organizationId,
        organizationId,
        inArray(schema.bookingReminder.bookingId, bookingIds)
      )
    );
  return rows.map(toRow);
}

export async function getReminderRow(
  organizationId: string,
  reminderId: string
): Promise<ReminderRow | null> {
  const rows = await getDb()
    .select(rowColumns)
    .from(schema.bookingReminder)
    .leftJoin(
      schema.message,
      eq(schema.bookingReminder.messageId, schema.message.id)
    )
    .where(
      scoped(
        schema.bookingReminder.organizationId,
        organizationId,
        eq(schema.bookingReminder.id, reminderId)
      )
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * CLAIM ATÓMICO (RF-10-05): `INSERT … ON CONFLICT DO NOTHING RETURNING` contra
 * `booking_reminder_claim_uq (booking_id, offset_minutes, scheduled_for)`.
 * Devuelve el id si este proceso ganó; `null` si otro tick (u otra réplica)
 * ya tenía la terna. Quien pierde NO envía.
 */
export async function insertReminderClaim(input: {
  organizationId: string;
  bookingId: string;
  offsetMinutes: number;
  scheduledFor: Date;
  templateId: string | null;
  now: Date;
}): Promise<string | null> {
  const rows = await getDb()
    .insert(schema.bookingReminder)
    .values({
      id: newId("bookingReminder"),
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      offsetMinutes: input.offsetMinutes,
      scheduledFor: input.scheduledFor,
      status: "sending",
      templateId: input.templateId,
      attempts: 1,
      claimedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        schema.bookingReminder.bookingId,
        schema.bookingReminder.offsetMinutes,
        schema.bookingReminder.scheduledFor,
      ],
    })
    .returning({ id: schema.bookingReminder.id });
  return rows[0]?.id ?? null;
}

/** Resultado de un envío (o de un salto) sobre la fila reclamada. */
export async function updateReminder(
  organizationId: string,
  reminderId: string,
  patch: ReminderPatch,
  now: Date
): Promise<void> {
  await getDb()
    .update(schema.bookingReminder)
    .set({ ...patch, updatedAt: now })
    .where(
      scoped(
        schema.bookingReminder.organizationId,
        organizationId,
        eq(schema.bookingReminder.id, reminderId)
      )
    );
}

/**
 * `sending` con `claimed_at` más viejo que 10 min → `failed / interrumpido`
 * (RF-10-10). No reenvía. Sin organización: todas (lo usa el tick, que
 * también rescata las de organizaciones que apagaron los recordatorios).
 */
export async function markStuckReminders(
  now: Date,
  organizationId?: string
): Promise<{ id: string; bookingId: string; organizationId: string }[]> {
  const cutoff = new Date(now.getTime() - REMINDER_STUCK_AFTER_MS);
  const stuck = and(
    eq(schema.bookingReminder.status, "sending"),
    lt(schema.bookingReminder.claimedAt, cutoff)
  );
  return getDb()
    .update(schema.bookingReminder)
    .set({
      status: "failed",
      error: REMINDER_INTERRUPTED_ERROR,
      updatedAt: now,
    })
    .where(
      organizationId
        ? scoped(schema.bookingReminder.organizationId, organizationId, stuck)
        : stuck
    )
    .returning({
      id: schema.bookingReminder.id,
      bookingId: schema.bookingReminder.bookingId,
      organizationId: schema.bookingReminder.organizationId,
    });
}

/**
 * Reintento manual (D-10-02): `failed → sending` con UPDATE CONDICIONADO
 * (`status = 'failed' AND attempts <= 1`) + RETURNING. Dos clics a la vez:
 * uno gana, el otro recibe `false`. Reusa la misma fila.
 */
export async function claimReminderRetry(input: {
  organizationId: string;
  bookingId: string;
  reminderId: string;
  now: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .update(schema.bookingReminder)
    .set({
      status: "sending",
      attempts: sql`${schema.bookingReminder.attempts} + 1`,
      claimedAt: input.now,
      updatedAt: input.now,
      error: null,
      reason: null,
    })
    .where(
      scoped(
        schema.bookingReminder.organizationId,
        input.organizationId,
        eq(schema.bookingReminder.id, input.reminderId),
        eq(schema.bookingReminder.bookingId, input.bookingId),
        eq(schema.bookingReminder.status, "failed"),
        lte(schema.bookingReminder.attempts, REMINDER_MAX_MANUAL_RETRIES)
      )
    )
    .returning({ id: schema.bookingReminder.id });
  return rows.length > 0;
}

export async function getReminderTemplate(
  organizationId: string,
  templateId: string
): Promise<ReminderTemplate | null> {
  const rows = await getDb()
    .select({
      id: schema.template.id,
      status: schema.template.status,
      body: schema.template.body,
    })
    .from(schema.template)
    .where(
      scoped(
        schema.template.organizationId,
        organizationId,
        eq(schema.template.id, templateId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** 025 — Trato del perfil del agente (respaldos de los recordatorios). */
export async function getAgentFormality(organizationId: string): Promise<Formality> {
  const rows = await getDb()
    .select({ formality: schema.agentProfile.formality })
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  return normalizeFormality(rows[0]?.formality);
}

export async function getOrganizationName(organizationId: string): Promise<string> {
  // `organization` ES el tenant: su llave primaria es el organization_id.
  const rows = await getDb()
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  return rows[0]?.name ?? "";
}

/** La conversación real (no prueba) del contacto, si existe y es de WhatsApp. */
export async function findRealConversation(
  organizationId: string,
  contactId: string
): Promise<{ id: string; isTest: boolean; channel: string } | null> {
  const rows = await getDb()
    .select({
      id: schema.conversation.id,
      isTest: schema.conversation.isTest,
      channel: schema.conversation.channel,
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.contactId, contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getConversationBrief(
  organizationId: string,
  conversationId: string
): Promise<{ id: string; isTest: boolean; channel: string } | null> {
  const rows = await getDb()
    .select({
      id: schema.conversation.id,
      isTest: schema.conversation.isTest,
      channel: schema.conversation.channel,
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** El `wa_message_id` del mensaje que dejó `sendTemplate` (copia cruda). */
export async function getMessageWaId(
  organizationId: string,
  messageId: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ waMessageId: schema.message.waMessageId })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.id, messageId)
      )
    )
    .limit(1);
  return rows[0]?.waMessageId ?? null;
}

// ── Normalización de ajustes (jsonb sin garantías) ───────────────────────

export function normalizeOffsets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_REMINDER_OFFSETS_MINUTES];
  const out = raw.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0
  );
  return out.length > 0 ? [...new Set(out)] : [...DEFAULT_REMINDER_OFFSETS_MINUTES];
}

/**
 * El índice ES la posición `{{n}}`: filtrar un campo desconocido correría los
 * demás de lugar. Un mapeo con algo fuera del catálogo se descarta entero.
 */
export function normalizeVariables(raw: unknown): ReminderField[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.every((v) =>
    (REMINDER_FIELDS as readonly string[]).includes(v as string)
  );
  return valid ? (raw as ReminderField[]) : [];
}
