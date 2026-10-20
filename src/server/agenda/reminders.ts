import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { MetaApiError } from "@/lib/meta/client";
import {
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  ADDRESS_FALLBACK,
  APPOINTMENT_TYPE_FALLBACK,
  MEETING_LINK_FALLBACK,
  REMINDER_MAX_MANUAL_RETRIES,
  REMINDER_MAX_OFFSETS,
  REMINDER_MIN_LEAD_MS,
  REMINDER_OFFSET_LIMITS,
  REMINDER_TICK_BATCH,
  reminderDueAt,
  reminderTiming,
  type BookingReminderDto,
  type BookingReminderSkipReason,
  type ReminderField,
  type ReminderSettingsDto,
  type ReminderSettingsInput,
  type ReminderTickResultDto,
} from "@/lib/reminders";
import { countVariables } from "@/lib/templates";
import { labelInTz } from "@/lib/time/slots";
import { CalendarSettingsError } from "@/server/agenda/settings";
import * as store from "@/server/agenda/reminder-store";
import type {
  ReminderBooking,
  ReminderOrgConfig,
  ReminderRow,
  ReminderTemplate,
} from "@/server/agenda/reminder-store";
import { publish } from "@/server/events/bus";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { SendError } from "@/server/inbox/send";
import { sendTemplate, TemplateError } from "@/server/whatsapp/templates";

/**
 * 10 — Recordatorios de cita (dev-tasks/10-recordatorio-de-citas-y-no-shows.md,
 * «Contrato 10-0»). Detrás de la bandera AGENDA: con ella apagada el ticker no
 * arranca y las rutas responden 404 antes de llegar aquí.
 *
 * Reloj INYECTABLE: toda función de la lógica recibe `now: Date` y es ella la
 * que escribe `claimed_at`/`sent_at`/`updated_at` con ese valor. Nada de
 * `DEFAULT now()` ni `now()` de SQL en la lógica — así un test prueba
 * "interrumpido a los 10 min" llamando con `now + 11 min`, sin esperar.
 *
 * Reglas:
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

// ── Variables (catálogo cerrado, D-10-03) ────────────────────────────────

/** Respaldos: Meta rechaza un parámetro vacío (132000) y `sendTemplate` también. */
export const CONTACT_NAME_FALLBACK = "cliente";
export const BUSINESS_NAME_FALLBACK = "nuestro equipo";

export type ReminderVariableContext = {
  contactName: string | null;
  scheduledAt: Date;
  timezone: string;
  meetingLink: string | null;
  businessName: string | null;
  /** 023 (A8) — Nombre del tipo de cita; vacío ⇒ "tu cita". */
  appointmentType?: string | null;
  /** 023 (A8) — Dirección del negocio; vacía ⇒ "nuestra sucursal". */
  address?: string | null;
};

/** Un texto por `{{n}}` (índice = n − 1). Nunca devuelve un valor vacío. */
export function renderReminderVariables(
  fields: readonly ReminderField[],
  ctx: ReminderVariableContext
): string[] {
  return fields.map((field) => {
    switch (field) {
      case "contact_name":
        return nonEmpty(ctx.contactName) ?? CONTACT_NAME_FALLBACK;
      case "booking_datetime":
        return (
          nonEmpty(labelInTz(ctx.scheduledAt.toISOString(), ctx.timezone)) ??
          ctx.scheduledAt.toISOString()
        );
      case "meeting_link":
        return nonEmpty(ctx.meetingLink) ?? MEETING_LINK_FALLBACK;
      case "business_name":
        return nonEmpty(ctx.businessName) ?? BUSINESS_NAME_FALLBACK;
      case "appointment_type":
        return nonEmpty(ctx.appointmentType) ?? APPOINTMENT_TYPE_FALLBACK;
      case "address":
        return nonEmpty(ctx.address) ?? ADDRESS_FALLBACK;
    }
  });
}

function nonEmpty(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

// ── Traducción de fallos ─────────────────────────────────────────────────

export type ReminderOutcome =
  | { status: "sent"; messageId: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: BookingReminderSkipReason };

/**
 * Error del envío → `failed` (reintentable a mano) o `skipped` (configuración:
 * reintentar daría lo mismo). Lo desconocido es `failed` con un texto
 * genérico: el detalle va al log, no a la pantalla.
 */
export function classifySendError(err: unknown): ReminderOutcome {
  if (err instanceof TemplateError || err instanceof SendError) {
    if (err.code === "not_connected") return { status: "skipped", reason: "not_connected" };
    if (err.code === "reconnect_required") {
      return { status: "skipped", reason: "reconnect_required" };
    }
    return { status: "failed", error: err.message };
  }
  if (err instanceof MetaApiError) return { status: "failed", error: err.message };
  console.error("[reminders] fallo inesperado al enviar:", err);
  return { status: "failed", error: "No se pudo enviar el recordatorio" };
}

// ── Envío de UNA fila reclamada ──────────────────────────────────────────

type DeliveryContext = {
  organizationId: string;
  config: ReminderOrgConfig;
  template: ReminderTemplate | null;
  businessName: () => Promise<string>;
};

/** Decide, envía y deja la fila en `sent | failed | skipped`. Nunca lanza. */
async function deliverReminder(
  ctx: DeliveryContext,
  booking: ReminderBooking,
  reminderId: string,
  now: Date
): Promise<ReminderOutcome> {
  let outcome: ReminderOutcome;
  try {
    outcome = await attemptDelivery(ctx, booking);
  } catch (err) {
    outcome = classifySendError(err);
  }

  let waMessageId: string | null = null;
  if (outcome.status === "sent") {
    waMessageId = await store
      .getMessageWaId(ctx.organizationId, outcome.messageId)
      .catch(() => null);
  }

  try {
    await store.updateReminder(
      ctx.organizationId,
      reminderId,
      outcome.status === "sent"
        ? {
            status: "sent",
            messageId: outcome.messageId,
            waMessageId,
            sentAt: now,
            reason: null,
            error: null,
            templateId: ctx.config.templateId,
          }
        : outcome.status === "failed"
          ? { status: "failed", error: outcome.error, reason: null }
          : { status: "skipped", reason: outcome.reason, error: null },
      now
    );
  } catch (err) {
    // La fila queda `sending`: `recoverStuckReminders` la pasa a
    // `failed / interrumpido` a los 10 min. Jamás se reenvía sola.
    console.error("[reminders] no se pudo registrar el resultado:", err);
  }
  publishBooking(ctx.organizationId, booking.id);
  return outcome;
}

async function attemptDelivery(
  ctx: DeliveryContext,
  booking: ReminderBooking
): Promise<ReminderOutcome> {
  const { template, config } = ctx;
  if (!config.templateId || !template) {
    return { status: "skipped", reason: "template_missing" };
  }
  if (template.status !== "approved") {
    return { status: "skipped", reason: "template_not_approved" };
  }
  const contact = booking.contact;
  if (!contact) return { status: "skipped", reason: "no_recipient" };
  if (contact.channel !== "whatsapp") {
    return { status: "skipped", reason: "channel_not_whatsapp" };
  }
  // `sendTemplate` lo reportaría como `meta_error` genérico: se resuelve aquí.
  if (!nonEmpty(contact.phone) && !nonEmpty(contact.waUserId)) {
    return { status: "skipped", reason: "no_recipient" };
  }

  const conversationId = await resolveConversation(ctx.organizationId, booking, contact.id);

  const fields = config.variables.slice(0, countVariables(template.body));
  const needsBusiness = fields.includes("business_name");
  const variables = renderReminderVariables(fields, {
    contactName: contact.name,
    scheduledAt: booking.scheduledAt,
    timezone: config.timezone,
    meetingLink: booking.meetingLink,
    businessName: needsBusiness ? await ctx.businessName() : null,
    appointmentType: booking.appointmentTypeName ?? null,
    address: config.address ?? null,
  });

  // Segunda barrera del sandbox: si la conversación es de prueba,
  // `sendTemplate` lanza `sandbox_violation` → `failed`. No se esquiva.
  const sent = await sendTemplate({
    organizationId: ctx.organizationId,
    conversationId,
    templateId: template.id,
    variables,
  });
  return { status: "sent", messageId: sent.messageId };
}

/** RF-10-08: la de la cita; si no hay, la real del contacto; si no, se crea. */
async function resolveConversation(
  organizationId: string,
  booking: ReminderBooking,
  contactId: string
): Promise<string> {
  if (booking.conversationId) {
    const conv = await store.getConversationBrief(organizationId, booking.conversationId);
    if (conv) return conv.id;
  }
  const real = await store.findRealConversation(organizationId, contactId);
  if (real) return real.id;
  const created = await getOrCreateConversation(organizationId, contactId);
  return created.id;
}

function publishBooking(organizationId: string, bookingId: string): void {
  try {
    publish(organizationId, { type: "booking.updated", data: { bookingId } });
  } catch {
    /* el SSE es cortesía: jamás tumba un envío */
  }
}

function deliveryContext(
  organizationId: string,
  config: ReminderOrgConfig,
  template: ReminderTemplate | null
): DeliveryContext {
  let name: Promise<string> | null = null;
  return {
    organizationId,
    config,
    template,
    businessName: () => {
      name ??= store.getOrganizationName(organizationId).catch(() => "");
      return name;
    },
  };
}

async function loadTemplate(
  organizationId: string,
  templateId: string | null
): Promise<ReminderTemplate | null> {
  if (!templateId) return null;
  return store.getReminderTemplate(organizationId, templateId);
}

// ── Tick ─────────────────────────────────────────────────────────────────

/**
 * Una vuelta completa: rescata los `sending` colgados, y por cada organización
 * con `reminder_enabled = true`: candidatos (RF-10-04 con `reminderTiming`),
 * claim por `INSERT … ON CONFLICT DO NOTHING RETURNING` (estado inicial
 * `sending`, `claimed_at = now`), envío en serie con tope
 * `REMINDER_TICK_BATCH` claims por organización. Un fallo de una organización
 * o de un recordatorio no detiene a los demás.
 *
 * La ruta dev `POST /api/dev/reminders/tick` la llama DIRECTO (sin el ticker
 * ni su `inFlight`), para que dos POST paralelos ejerciten el UNIQUE.
 */
export async function runReminderTick(now: Date): Promise<ReminderTickResultDto> {
  const result: ReminderTickResultDto = {
    now: now.toISOString(),
    organizations: 0,
    recovered: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    result.recovered = await recoverStuckReminders(now);
  } catch (err) {
    console.error("[reminders] rescate de envíos colgados falló:", err);
  }

  const orgs = await store.listReminderOrganizations();
  result.organizations = orgs.length;
  for (const config of orgs) {
    try {
      await tickOrganization(config, now, result);
    } catch (err) {
      console.error(
        `[reminders] vuelta de la organización ${config.organizationId} falló:`,
        err
      );
    }
  }
  return result;
}

async function tickOrganization(
  config: ReminderOrgConfig,
  now: Date,
  result: ReminderTickResultDto
): Promise<void> {
  const orgId = config.organizationId;
  const offsets = [...config.offsetsMinutes].sort((a, b) => b - a);
  const maxOffset = offsets[0];
  if (maxOffset === undefined) return;

  const bookings = await store.listCandidateBookings(orgId, now, maxOffset);
  if (bookings.length === 0) return;
  const rows = await store.listReminderRows(
    orgId,
    bookings.map((b) => b.id)
  );
  const template = await loadTemplate(orgId, config.templateId);
  const ctx = deliveryContext(orgId, config, template);

  let claimed = 0;
  for (const booking of bookings) {
    const current = rows.filter(
      (r) =>
        r.bookingId === booking.id &&
        r.scheduledFor.getTime() === booking.scheduledAt.getTime()
    );
    // Tope duro: nunca más `sent` por cita y hora que anticipaciones
    // configuradas (cambiar 24 h → 23 h no produce un segundo aviso).
    let sentCount = current.filter((r) => r.status === "sent").length;

    for (const offset of offsets) {
      if (claimed >= REMINDER_TICK_BATCH) return;
      if (sentCount >= offsets.length) break;
      if (current.some((r) => r.offsetMinutes === offset)) continue;
      const verdict = reminderTiming(
        {
          scheduledAt: booking.scheduledAt,
          bookingCreatedAt: booking.createdAt,
          offsetMinutes: offset,
          enabledAt: config.enabledAt,
        },
        now
      );
      if (verdict !== null) continue;

      const id = await store.insertReminderClaim({
        organizationId: orgId,
        bookingId: booking.id,
        offsetMinutes: offset,
        scheduledFor: booking.scheduledAt,
        templateId: config.templateId,
        now,
      });
      // Otro tick (u otra réplica) ganó la terna: no se envía nada.
      if (!id) continue;
      claimed++;
      result.claimed++;
      publishBooking(orgId, booking.id);

      const outcome = await deliverReminder(ctx, booking, id, now);
      result[outcome.status]++;
      if (outcome.status === "sent") sentCount++;
    }
  }
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
  const rows = await store.markStuckReminders(now, organizationId);
  for (const r of rows) publishBooking(r.organizationId, r.bookingId);
  return rows.length;
}

// ── Reintento manual ─────────────────────────────────────────────────────

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
  const { organizationId, bookingId, reminderId, now } = input;
  const row = await store.getReminderRow(organizationId, reminderId);
  if (!row || row.bookingId !== bookingId) {
    throw new ReminderError("not_found", "Recordatorio no encontrado");
  }
  const booking = await store.getReminderBooking(organizationId, bookingId);
  if (!booking) throw new ReminderError("not_found", "Recordatorio no encontrado");

  if (row.status !== "failed") {
    throw new ReminderError("not_retryable", "Este recordatorio no está fallido");
  }
  if (row.attempts > REMINDER_MAX_MANUAL_RETRIES) {
    throw new ReminderError(
      "retry_exhausted",
      "Este recordatorio ya se reintentó una vez"
    );
  }
  if (!bookingActiveFor(booking, row.scheduledFor, now)) {
    throw new ReminderError(
      "booking_not_active",
      "La cita ya no está agendada o está por empezar"
    );
  }

  const won = await store.claimReminderRetry({ organizationId, bookingId, reminderId, now });
  if (!won) {
    const again = await store.getReminderRow(organizationId, reminderId);
    if (again?.status === "failed" && again.attempts > REMINDER_MAX_MANUAL_RETRIES) {
      throw new ReminderError(
        "retry_exhausted",
        "Este recordatorio ya se reintentó una vez"
      );
    }
    throw new ReminderError("not_retryable", "Este recordatorio ya se está reintentando");
  }
  publishBooking(organizationId, bookingId);

  const config = (await store.getReminderOrgConfig(organizationId)) ?? emptyConfig(organizationId);
  const template = await loadTemplate(organizationId, config.templateId).catch(() => null);
  await deliverReminder(deliveryContext(organizationId, config, template), booking, reminderId, now);

  const final = await store.getReminderRow(organizationId, reminderId);
  if (!final) throw new ReminderError("not_found", "Recordatorio no encontrado");
  return toReminderDto(final, booking, now);
}

function bookingActiveFor(booking: ReminderBooking, scheduledFor: Date, now: Date): boolean {
  return (
    booking.kind === "session" &&
    booking.status === "agendada" &&
    !booking.isTest &&
    booking.scheduledAt.getTime() === scheduledFor.getTime() &&
    booking.scheduledAt.getTime() - now.getTime() >= REMINDER_MIN_LEAD_MS
  );
}

function emptyConfig(organizationId: string): ReminderOrgConfig {
  return {
    organizationId,
    enabled: false,
    enabledAt: null,
    templateId: null,
    offsetsMinutes: [...DEFAULT_REMINDER_OFFSETS_MINUTES],
    variables: [],
    timezone: "America/Mexico_City",
  };
}

// ── DTO para Citas ───────────────────────────────────────────────────────

export function toReminderDto(
  row: ReminderRow,
  booking: ReminderBooking,
  now: Date
): BookingReminderDto {
  return {
    id: row.id,
    offsetMinutes: row.offsetMinutes,
    scheduledFor: row.scheduledFor.toISOString(),
    dueAt: reminderDueAt(row.scheduledFor, row.offsetMinutes).toISOString(),
    status: row.status,
    reason: row.status === "skipped" ? row.reason : null,
    error: row.status === "failed" ? row.error : null,
    sentAt: row.sentAt?.toISOString() ?? null,
    attempts: row.attempts,
    canRetry:
      row.status === "failed" &&
      row.attempts <= REMINDER_MAX_MANUAL_RETRIES &&
      bookingActiveFor(booking, row.scheduledFor, now),
    delivery: row.delivery,
    deliveryError: row.deliveryError,
  };
}

function pendingDto(booking: ReminderBooking, offsetMinutes: number): BookingReminderDto {
  return {
    id: null,
    offsetMinutes,
    scheduledFor: booking.scheduledAt.toISOString(),
    dueAt: reminderDueAt(booking.scheduledAt, offsetMinutes).toISOString(),
    status: "pending",
    reason: null,
    error: null,
    sentAt: null,
    attempts: 0,
    canRetry: false,
    delivery: null,
    deliveryError: null,
  };
}

/**
 * Recordatorios de la hora VIGENTE de cada cita (`scheduled_for =
 * scheduled_at`), con el estado de entrega del `message` enlazado, más los
 * `pending` sintetizados de las anticipaciones sin fila que todavía pueden
 * salir. Vacío en bloqueos, en citas de prueba y con los recordatorios
 * apagados. Nunca lanza: un fallo aquí no puede tumbar `GET /api/bookings`.
 */
export async function remindersForBookings(
  organizationId: string,
  bookingIds: string[],
  now: Date
): Promise<Map<string, BookingReminderDto[]>> {
  const out = new Map<string, BookingReminderDto[]>();
  if (bookingIds.length === 0) return out;
  try {
    const config = await store.getReminderOrgConfig(organizationId);
    if (!config?.enabled) return out;
    const bookings = (await store.getReminderBookings(organizationId, bookingIds)).filter(
      (b) => b.kind === "session" && !b.isTest
    );
    if (bookings.length === 0) return out;
    const rows = await store.listReminderRows(
      organizationId,
      bookings.map((b) => b.id)
    );

    for (const booking of bookings) {
      const current = rows.filter(
        (r) =>
          r.bookingId === booking.id &&
          r.scheduledFor.getTime() === booking.scheduledAt.getTime()
      );
      const dtos = current.map((r) => toReminderDto(r, booking, now));
      if (booking.status === "agendada") {
        for (const offset of config.offsetsMinutes) {
          if (current.some((r) => r.offsetMinutes === offset)) continue;
          const verdict = reminderTiming(
            {
              scheduledAt: booking.scheduledAt,
              bookingCreatedAt: booking.createdAt,
              offsetMinutes: offset,
              enabledAt: config.enabledAt,
            },
            now
          );
          // Solo lo que TODAVÍA puede salir: lo vencido sin fila ya no sale.
          if (verdict === null || verdict === "not_due") {
            dtos.push(pendingDto(booking, offset));
          }
        }
      }
      dtos.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
      out.set(booking.id, dtos);
    }
    return out;
  } catch (err) {
    console.warn("[reminders] no se pudieron leer los recordatorios de Citas:", err);
    return new Map();
  }
}

// ── Ajustes ──────────────────────────────────────────────────────────────

export type ReminderSettingsPlan = {
  enabled: boolean;
  enabledAt: Date | null;
  templateId: string | null;
  offsetsMinutes: number[];
  variables: ReminderField[];
};

/**
 * Valida y resuelve los ajustes de recordatorio RESULTANTES (lo guardado +
 * lo que llega). Lanza `CalendarSettingsError` (→ 422) si encender no es
 * posible: plantilla inexistente, no aprobada, o mapeo que no cubre
 * EXACTAMENTE cada `{{n}}`. Las plantillas de Vocero son solo de WhatsApp
 * (`sendTemplate` rechaza otro canal), así que "aprobada" ya implica canal.
 *
 * `enabledAt = now` en cada transición apagado → encendido (D nueva del
 * contrato): encender no dispara una ráfaga sobre lo ya agendado. Apagar no
 * lo borra.
 */
export async function planReminderSettings(
  organizationId: string,
  input: ReminderSettingsInput,
  now: Date
): Promise<ReminderSettingsPlan> {
  const current =
    (await store.getReminderOrgConfig(organizationId)) ?? emptyConfig(organizationId);

  const next = {
    enabled: input.reminderEnabled ?? current.enabled,
    templateId:
      input.reminderTemplateId !== undefined ? input.reminderTemplateId : current.templateId,
    offsetsMinutes: input.reminderOffsetsMinutes ?? current.offsetsMinutes,
    variables: input.reminderVariables ?? current.variables,
  };

  const offsets = next.offsetsMinutes;
  if (
    offsets.length < 1 ||
    offsets.length > REMINDER_MAX_OFFSETS ||
    new Set(offsets).size !== offsets.length ||
    offsets.some(
      (o) =>
        !Number.isInteger(o) ||
        o < REMINDER_OFFSET_LIMITS.min ||
        o > REMINDER_OFFSET_LIMITS.max
    )
  ) {
    throw new CalendarSettingsError(
      "Anticipaciones inválidas: 1 o 2 valores distintos, de 1 a 72 horas"
    );
  }

  const template = next.templateId
    ? await store.getReminderTemplate(organizationId, next.templateId)
    : null;
  if (next.templateId && !template) {
    throw new CalendarSettingsError("La plantilla elegida no existe");
  }

  let variables = next.variables;
  if (next.enabled) {
    if (!template) {
      throw new CalendarSettingsError(
        "Para activar los recordatorios elige una plantilla aprobada de WhatsApp"
      );
    }
    if (template.status !== "approved") {
      throw new CalendarSettingsError(
        "La plantilla elegida no está aprobada por Meta: elige una aprobada"
      );
    }
    const count = countVariables(template.body);
    if (variables.length !== count) {
      throw new CalendarSettingsError(
        count === 0
          ? "Esta plantilla no tiene variables: no asignes campos"
          : `La plantilla tiene ${count} variable(s): asigna un campo a cada una, de {{1}} a {{${count}}}`
      );
    }
  } else if (template && variables.length > countVariables(template.body)) {
    // Apagado se guarda lo que haya; lo que sobra jamás llegaría a Meta.
    variables = variables.slice(0, countVariables(template.body));
  }

  return {
    enabled: next.enabled,
    enabledAt: !current.enabled && next.enabled ? now : current.enabledAt,
    templateId: next.templateId,
    offsetsMinutes: [...offsets],
    variables: [...variables],
  };
}

export async function saveReminderSettings(
  organizationId: string,
  plan: ReminderSettingsPlan,
  now: Date
): Promise<void> {
  await store.saveReminderOrgConfig(organizationId, plan, now);
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
    offsetsMinutes: store.normalizeOffsets(row.offsets),
    variables: store.normalizeVariables(row.variables),
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
