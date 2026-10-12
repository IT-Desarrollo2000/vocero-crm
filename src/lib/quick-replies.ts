/**
 * 09 — Respuestas rápidas: constantes del contrato compartidas por servidor
 * (validación al guardar) y cliente (render en el compositor). Sin
 * dependencias de servidor.
 *
 * Las funciones puras (`findUnknownVars`, `renderQuickReply`, `slashQuery`,
 * `matchQuickReplies`, `normalizeShortcut`, esquema Zod) llegan con T-09-11 y
 * viven AQUÍ, sin cambiar estas constantes.
 */

/**
 * Variables admitidas en `body`, escritas `{{variable}}` (se toleran espacios
 * dentro de las llaves: `{{ nombre }}`). Cualquier otra → 422
 * `unknown_variable` al guardar.
 *
 *   nombre           primer nombre del contacto ("María López" → "María")
 *   nombre_completo  nombre completo del contacto
 *   vendedor         nombre de quien envía (`useViewer().name`)
 *   negocio          nombre de la Marca (`useViewer().businessName`)
 *
 * Sin valor (p. ej. contacto sin nombre) → cadena vacía y se colapsan los
 * espacios dobles (RF-09-24).
 */
export const QUICK_REPLY_VARS = [
  "nombre",
  "nombre_completo",
  "vendedor",
  "negocio",
] as const;

export type QuickReplyVar = (typeof QUICK_REPLY_VARS)[number];

/** Patrón de una variable dentro del cuerpo (global: usar con matchAll). */
export const QUICK_REPLY_VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * Límites (RF-09-20). `shortcut` se normaliza antes de validar: trim, sin `/`
 * inicial y en minúsculas; único por org (duplicado → 409
 * `duplicate_shortcut`). `body` comparte tope con el envío de texto.
 */
export const QUICK_REPLY_LIMITS = {
  shortcutPattern: /^[a-z0-9_-]{1,32}$/,
  titleMax: 80,
  bodyMax: 4096,
} as const;
