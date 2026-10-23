import { z } from "zod";
import {
  OVERDUE_DEFAULT_MINUTES,
  OVERDUE_MAX_MINUTES,
  OVERDUE_MIN_MINUTES,
} from "@/lib/awaiting";

/**
 * 022 — Contrato de los ajustes de la Bandeja (archivo de conversaciones;
 * 026: umbral de "atrasada" de la vista Por atender).
 * Compartido por la API (`/api/settings/inbox`,
 * `/api/conversations/archive-inactive`) y la UI de Ajustes → Bandeja.
 */

/** Umbral de inactividad por defecto (decisión del dueño, spec 022). */
export const AUTO_ARCHIVE_DEFAULT_DAYS = 14;
export const AUTO_ARCHIVE_MIN_DAYS = 1;
export const AUTO_ARCHIVE_MAX_DAYS = 365;

export type InboxSettingsDto = {
  /** Auto-archivo encendido. Apagado por defecto. */
  autoArchiveEnabled: boolean;
  /** Días sin actividad para considerar inactiva una conversación (1–365). */
  autoArchiveDays: number;
  /**
   * 026: minutos de espera del cliente a partir de los que un chat "Por
   * atender" sale atrasado (rojo). 5–1440, por defecto 60.
   */
  overdueMinutes: number;
  /**
   * 029: los Vendedores pueden crear respuestas rápidas (y editar/borrar las
   * suyas). Encendido por defecto.
   */
  sellersCreateQuickReplies: boolean;
};

/** Sin fila en `inbox_settings` = esto. */
export const DEFAULT_INBOX_SETTINGS: InboxSettingsDto = {
  autoArchiveEnabled: false,
  autoArchiveDays: AUTO_ARCHIVE_DEFAULT_DAYS,
  overdueMinutes: OVERDUE_DEFAULT_MINUTES,
  sellersCreateQuickReplies: true,
};

const daysSchema = z
  .number()
  .int()
  .min(AUTO_ARCHIVE_MIN_DAYS)
  .max(AUTO_ARCHIVE_MAX_DAYS);

/**
 * Body de `PUT /api/settings/inbox`. Parcial (029): cada pestaña manda solo
 * lo suyo (Bandeja: archivo + umbral; Respuestas rápidas: el interruptor) y
 * lo que no viene se conserva tal cual está guardado. Al menos un campo.
 */
export const inboxSettingsSchema = z
  .object({
    autoArchiveEnabled: z.boolean().optional(),
    autoArchiveDays: daysSchema.optional(),
    // 026: umbral de "atrasada". 029: sin el campo se conserva (antes volvía a 60).
    overdueMinutes: z
      .number()
      .int()
      .min(OVERDUE_MIN_MINUTES)
      .max(OVERDUE_MAX_MINUTES)
      .optional(),
    sellersCreateQuickReplies: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Envía al menos un campo",
  });

/** Lo que guarda un PUT: solo los campos presentes. */
export type InboxSettingsPatch = z.infer<typeof inboxSettingsSchema>;

/** Body de `POST /api/conversations/archive-inactive`. */
export const archiveInactiveSchema = z.object({
  days: daysSchema,
  /** true = solo cuenta (vista previa), no archiva. */
  dryRun: z.boolean().default(false),
});
