/**
 * 10 — Ajustes → Agenda → Recordatorios: la lógica del formulario, sin React,
 * para probarla en unit.
 *
 * La UI habla en HORAS; el contrato (`PUT /api/calendar/settings`) en
 * MINUTOS. La conversión y los límites viven aquí para que el formulario
 * avise lo mismo que respondería el servidor con un 422.
 */

import {
  REMINDER_FIELDS,
  REMINDER_MAX_OFFSETS,
  REMINDER_OFFSET_LIMITS,
  type ReminderField,
  type ReminderSettingsDto,
  type ReminderSettingsInput,
} from "@/lib/reminders";
import { countVariables } from "@/lib/templates";
import type { TemplateDto } from "@/lib/types";

/** Límites de cada anticipación, en horas (60..4320 min → 1..72 h). */
export const REMINDER_OFFSET_HOURS_LIMITS = {
  min: REMINDER_OFFSET_LIMITS.min / 60,
  max: REMINDER_OFFSET_LIMITS.max / 60,
} as const;

/** Anticipación sugerida al agregar un segundo aviso. */
export const SECOND_OFFSET_SUGGESTION_HOURS = 2;

/** Horas (lo que escribe el Propietario) → minutos enteros del contrato. */
export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

/** Minutos del contrato → horas para mostrar (1.5 si eran 90 min). */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** Un campo sin elegir todavía en el mapeo de variables. */
export type MappingSlot = ReminderField | "";

export type ReminderForm = {
  enabled: boolean;
  templateId: string | null;
  /** Lo que hay en cada caja de horas (puede ser NaN si la vaciaron). */
  offsetsHours: number[];
  /** Índice = `{{n}} − 1`. */
  variables: MappingSlot[];
};

/** Estado inicial del formulario a partir del DTO del servidor. */
export function formFromDto(dto: ReminderSettingsDto): ReminderForm {
  return {
    enabled: dto.enabled,
    templateId: dto.templateId,
    offsetsHours: dto.offsetsMinutes.map(minutesToHours),
    variables: [...dto.variables],
  };
}

/** Plantillas elegibles para el recordatorio: solo las aprobadas. */
export function approvedTemplates(templates: readonly TemplateDto[]): TemplateDto[] {
  return templates.filter((t) => t.status === "approved");
}

/** Cuántas variables `{{n}}` pide la plantilla (0 si no hay plantilla). */
export function templateVariableCount(template: Pick<TemplateDto, "body"> | null | undefined): number {
  return template ? countVariables(template.body) : 0;
}

/**
 * Ajusta el mapeo al número de variables de la plantilla: conserva lo ya
 * elegido en las primeras posiciones y deja vacías las nuevas.
 */
export function resizeMapping(variables: readonly MappingSlot[], count: number): MappingSlot[] {
  const next: MappingSlot[] = [];
  for (let i = 0; i < count; i++) next.push(variables[i] ?? "");
  return next;
}

function isReminderField(value: string): value is ReminderField {
  return (REMINDER_FIELDS as readonly string[]).includes(value);
}

/**
 * ¿El mapeo cubre cada `{{n}}` de la plantilla con un campo del catálogo?
 * Devuelve el mensaje del primer problema, o null si está completo.
 */
export function validateMapping(
  variables: readonly MappingSlot[],
  variableCount: number
): string | null {
  if (variables.length < variableCount) {
    return `Elige un campo para cada variable de la plantilla (faltan ${variableCount - variables.length}).`;
  }
  for (let i = 0; i < variableCount; i++) {
    const v = variables[i] ?? "";
    if (!isReminderField(v)) {
      return `Elige qué va en {{${i + 1}}}.`;
    }
  }
  return null;
}

/** Valida las anticipaciones (en horas) con los límites del contrato. */
export function validateOffsetsHours(offsetsHours: readonly number[]): string | null {
  if (offsetsHours.length < 1) return "Agrega al menos una anticipación.";
  if (offsetsHours.length > REMINDER_MAX_OFFSETS) {
    return `Como máximo ${REMINDER_MAX_OFFSETS} anticipaciones.`;
  }
  const { min, max } = REMINDER_OFFSET_HOURS_LIMITS;
  const minutes: number[] = [];
  for (const h of offsetsHours) {
    if (!Number.isFinite(h)) return "Escribe las horas de anticipación.";
    const m = hoursToMinutes(h);
    if (m < REMINDER_OFFSET_LIMITS.min || m > REMINDER_OFFSET_LIMITS.max) {
      return `Cada anticipación va de ${min} a ${max} horas.`;
    }
    minutes.push(m);
  }
  if (new Set(minutes).size !== minutes.length) {
    return "Las dos anticipaciones no pueden ser iguales.";
  }
  return null;
}

export type ReminderFormCheck =
  | { ok: true; input: Required<ReminderSettingsInput> }
  | { ok: false; message: string };

/**
 * Valida el formulario y arma el cuerpo del PUT (solo los campos de
 * recordatorio, en minutos). Con los recordatorios apagados no se exige
 * plantilla ni mapeo completo: se guardan como estén.
 */
export function buildReminderInput(
  form: ReminderForm,
  template: TemplateDto | null
): ReminderFormCheck {
  const offsetError = validateOffsetsHours(form.offsetsHours);
  if (offsetError) return { ok: false, message: offsetError };

  const count = templateVariableCount(template);
  if (form.enabled) {
    if (!form.templateId) {
      return { ok: false, message: "Elige la plantilla aprobada del recordatorio." };
    }
    if (!template || template.status !== "approved") {
      return {
        ok: false,
        message: "La plantilla elegida no está aprobada por Meta. Elige otra.",
      };
    }
    const mappingError = validateMapping(form.variables, count);
    if (mappingError) return { ok: false, message: mappingError };
  }

  // Con apagado y mapeo a medias, solo se manda el prefijo completo: un hueco
  // en medio correría las posiciones de las variables que siguen.
  const scope = template ? form.variables.slice(0, count) : form.variables;
  const contiguous: ReminderField[] = [];
  for (const v of scope) {
    if (!isReminderField(v)) break;
    contiguous.push(v);
  }

  return {
    ok: true,
    input: {
      reminderEnabled: form.enabled,
      reminderTemplateId: form.templateId,
      reminderOffsetsMinutes: form.offsetsHours.map(hoursToMinutes),
      reminderVariables: contiguous,
    },
  };
}

/** Aviso del DTO (`warning`) en palabras del Propietario. */
export function reminderWarningMessage(
  warning: ReminderSettingsDto["warning"]
): string | null {
  switch (warning) {
    case "template_missing":
      return "La plantilla del recordatorio ya no existe: mientras no elijas otra, los recordatorios no se enviarán.";
    case "template_not_approved":
      return "La plantilla del recordatorio ya no está aprobada por Meta: mientras no elijas otra, los recordatorios no se enviarán.";
    default:
      return null;
  }
}

export type ReminderSaveOutcome =
  | { kind: "ok"; reminders: ReminderSettingsDto }
  /** 501: el servidor aún no guarda recordatorios (contrato 10-0). */
  | { kind: "soon" }
  | { kind: "error"; message: string };

export const REMINDERS_SOON_MESSAGE =
  "Disponible pronto: esta instancia todavía no guarda recordatorios.";

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

/** Interpreta la respuesta del PUT (status + cuerpo ya parseado o null). */
export function classifyReminderSave(status: number, body: unknown): ReminderSaveOutcome {
  if (status === 501) return { kind: "soon" };
  if (status >= 200 && status < 300) {
    const reminders = (body as { reminders?: ReminderSettingsDto } | null)?.reminders;
    if (reminders && typeof reminders === "object") return { kind: "ok", reminders };
    return { kind: "error", message: "Respuesta inesperada del servidor." };
  }
  if (status === 403) {
    return { kind: "error", message: "Solo el Propietario puede cambiar los recordatorios." };
  }
  return {
    kind: "error",
    message: errorMessage(body) ?? "No se pudieron guardar los recordatorios.",
  };
}
