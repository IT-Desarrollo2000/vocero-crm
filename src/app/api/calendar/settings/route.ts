import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { CONNECTOR_ORDER } from "@/lib/agenda-connectors";
import {
  REMINDER_FIELDS,
  REMINDER_MAX_OFFSETS,
  REMINDER_OFFSET_LIMITS,
  REMINDER_SETTINGS_INPUT_KEYS,
} from "@/lib/reminders";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  getReminderSettings,
  planReminderSettings,
  saveReminderSettings,
} from "@/server/agenda/reminders";
import {
  CalendarSettingsError,
  getSettings,
  upsertSettings,
} from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

/**
 * 015 — La configuración de la agenda del negocio.
 *
 * Una instancia sin configurar responde 200 con los defaults, no 404: la
 * agenda ya es usable el día que se enciende.
 *
 * Jamás devuelve credenciales de un conector — esas viven en su propio
 * endpoint y solo salen como últimos 4 dígitos.
 *
 * 10 — Responde además `reminders` (`ReminderSettingsDto`,
 * `src/lib/reminders.ts`) como HERMANO de `settings`.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const [settings, reminders] = await Promise.all([
    getSettings(session.organizationId),
    getReminderSettings(session.organizationId),
  ]);
  return Response.json({ settings, reminders });
}, { role: "owner" });

const intervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const putSchema = z.object({
  weeklyHours: z.record(z.string(), z.array(intervalSchema)).optional(),
  slotMinutes: z.number().optional(),
  bufferMinutes: z.number().optional(),
  minNoticeHours: z.number().optional(),
  maxDaysAhead: z.number().optional(),
  timezone: z.string().optional(),
  // El catálogo manda: un conector que no existe se rechaza aquí, y el
  // servicio lo vuelve a comprobar por si el llamador no es esta ruta.
  connector: z
    .string()
    .refine((v) => (CONNECTOR_ORDER as readonly string[]).includes(v), {
      message: "Conector desconocido",
    })
    .optional(),
  meetingLink: z.string().nullish(),
  // 10 — Recordatorios (contrato 10-0). La FORMA se valida aquí; plantilla
  // aprobada de WhatsApp y un campo por cada {{n}} los valida el servicio
  // (422 `invalid_body` con mensaje).
  reminderEnabled: z.boolean().optional(),
  reminderTemplateId: z.string().min(1).nullish(),
  reminderOffsetsMinutes: z
    .array(
      z
        .number()
        .int()
        .min(REMINDER_OFFSET_LIMITS.min)
        .max(REMINDER_OFFSET_LIMITS.max)
    )
    .min(1)
    .max(REMINDER_MAX_OFFSETS)
    .refine((a) => new Set(a).size === a.length, {
      message: "Anticipaciones repetidas",
    })
    .optional(),
  reminderVariables: z.array(z.enum(REMINDER_FIELDS)).optional(),
});

/**
 * Guarda lo que se pueda salvar: los enteros fuera de rango se recortan y los
 * intervalos mal escritos se descartan, en vez de tumbar el horario entero por
 * una celda. Lo que sí se rechaza es lo que rompería el motor después: una
 * zona horaria que el runtime no conoce, o un conector inexistente.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const {
    reminderEnabled,
    reminderTemplateId,
    reminderOffsetsMinutes,
    reminderVariables,
    ...agenda
  } = body.data;
  const reminderInput = {
    reminderEnabled,
    reminderTemplateId,
    reminderOffsetsMinutes,
    reminderVariables,
  };
  const touchesReminders = REMINDER_SETTINGS_INPUT_KEYS.some(
    (k) => reminderInput[k] !== undefined
  );
  // Reloj de JS: `reminder_enabled_at` = este instante si se enciende ahora.
  const now = new Date();

  try {
    // 10 — Se valida ANTES de guardar nada: un 422 de recordatorios no deja
    // la agenda a medio guardar.
    const reminderPlan = touchesReminders
      ? await planReminderSettings(session.organizationId, reminderInput, now)
      : null;
    const settings = await upsertSettings(session.organizationId, {
      ...agenda,
      // `undefined` = no lo tocaron; `null` = lo vaciaron a propósito.
      meetingLink:
        agenda.meetingLink === undefined ? undefined : agenda.meetingLink,
    });
    // `upsertSettings` garantiza la fila; los recordatorios van encima.
    if (reminderPlan) {
      await saveReminderSettings(session.organizationId, reminderPlan, now);
    }
    const reminders = await getReminderSettings(session.organizationId);
    return Response.json({ settings, reminders });
  } catch (err) {
    if (err instanceof CalendarSettingsError) {
      return apiError(422, "invalid_body", err.message);
    }
    throw err;
  }
}, { role: "owner" });
