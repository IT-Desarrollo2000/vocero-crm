/**
 * 09 — Respuestas rápidas: constantes del contrato compartidas por servidor
 * (validación al guardar) y cliente (render en el compositor). Sin
 * dependencias de servidor.
 *
 * Funciones puras (T-09-11): `findUnknownVars`, `renderQuickReply`,
 * `slashQuery`, `matchQuickReplies`, `normalizeShortcut`, `firstName` y los
 * esquemas Zod `quickReplyCreateSchema` / `quickReplyPatchSchema`.
 */

import { z } from "zod";

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

/* ------------------------------------------------------------------ *
 * Funciones puras (T-09-11)
 * ------------------------------------------------------------------ */

const KNOWN_VARS: ReadonlySet<string> = new Set(QUICK_REPLY_VARS);

/** Copia del patrón global (evita compartir `lastIndex` entre llamadas). */
function varPattern(): RegExp {
  return new RegExp(QUICK_REPLY_VAR_PATTERN.source, "g");
}

/**
 * Atajo tal cual se guarda: sin espacios alrededor, sin `/` inicial(es) y en
 * minúsculas (`" /Horario "` → `"horario"`). No valida: eso lo hace
 * `QUICK_REPLY_LIMITS.shortcutPattern`.
 */
export function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\/+/, "").trim().toLowerCase();
}

/**
 * Variables del cuerpo que no están en `QUICK_REPLY_VARS`, sin repetir y en
 * orden de aparición (`"{{telefono}}"` → `["telefono"]`). Vacío = válido.
 */
export function findUnknownVars(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(varPattern())) {
    const name = match[1] ?? "";
    if (!KNOWN_VARS.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Mensaje del 422 `unknown_variable` (y del error en línea del formulario):
 * `Variable desconocida: {{telefono}}` / `Variables desconocidas: {{a}}, {{b}}`.
 */
export function unknownVariableMessage(names: readonly string[]): string {
  const list = names.map((n) => `{{${n}}}`).join(", ");
  return `${names.length === 1 ? "Variable desconocida" : "Variables desconocidas"}: ${list}`;
}

/** Primer nombre ("María López" → "María"); vacío si no hay nombre. */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Datos con que se rinde una respuesta rápida en el compositor.
 *
 * `nombre` puede venir ya como primer nombre o como el nombre completo del
 * contacto: `{{nombre}}` usa SIEMPRE la primera palabra de
 * `nombre ?? nombreCompleto`, y `{{nombre_completo}}` usa
 * `nombreCompleto ?? nombre`. Así basta con pasar `conversation.contact.name`
 * en cualquiera de los dos campos.
 */
export type QuickReplyContext = {
  nombre?: string | null;
  nombreCompleto?: string | null;
  /** Nombre de quien envía (`useViewer().name`). */
  vendedor?: string | null;
  /** Nombre de la Marca (`useViewer().businessName`). */
  negocio?: string | null;
};

/**
 * Sustituye las variables (RF-09-24). Una variable sin valor → cadena vacía;
 * después se colapsan los espacios repetidos (sin tocar los saltos de línea),
 * se quitan los espacios al final de cada línea y en los extremos y, si alguna
 * variable quedó vacía, el espacio huérfano antes de la puntuación
 * (`"Hola {{nombre}}, …"` sin nombre → `"Hola, …"`). Una variable
 * desconocida se deja tal cual (el servidor ya no deja guardarla).
 */
export function renderQuickReply(body: string, ctx: QuickReplyContext): string {
  const values: Record<string, string> = {
    nombre: firstName(ctx.nombre ?? ctx.nombreCompleto),
    nombre_completo: (ctx.nombreCompleto ?? ctx.nombre ?? "").trim(),
    vendedor: (ctx.vendedor ?? "").trim(),
    negocio: (ctx.negocio ?? "").trim(),
  };
  let emptied = false;
  let out = body.replace(varPattern(), (whole, name: string) => {
    if (!KNOWN_VARS.has(name)) return whole;
    const value = values[name] ?? "";
    if (!value) emptied = true;
    return value;
  });
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "");
  if (emptied) out = out.replace(/[ \t]+([,.;:!?])/g, "$1");
  return out.trim();
}

/**
 * ¿El caret está sobre un atajo `/consulta`? (RF-09-23). Solo dispara si la
 * `/` está al inicio del campo o tras un espacio/salto ("1/2 kilo" no), y lo
 * que sigue hasta el caret son caracteres de atajo. Devuelve la consulta en
 * minúsculas (sin la barra) y el índice de la `/`: al insertar se reemplaza
 * `text.slice(start, caret)`.
 */
export function slashQuery(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /(^|\s)\/([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  return { query: (m[2] ?? "").toLowerCase(), start: m.index + (m[1] ?? "").length };
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Filtra el catálogo por atajo o título (sin distinguir mayúsculas ni
 * acentos). Primero las que empiezan por la consulta en el atajo; después el
 * resto, cada grupo en el orden recibido (el GET ya viene por `position`).
 * Consulta vacía → todas.
 */
export function matchQuickReplies<T extends { shortcut: string; title: string }>(
  list: readonly T[],
  query: string
): T[] {
  const q = fold(query.trim().replace(/^\/+/, ""));
  if (!q) return [...list];
  const prefix: T[] = [];
  const rest: T[] = [];
  for (const item of list) {
    const shortcut = fold(item.shortcut);
    if (shortcut.startsWith(q)) prefix.push(item);
    else if (shortcut.includes(q) || fold(item.title).includes(q)) rest.push(item);
  }
  return [...prefix, ...rest];
}

/* ------------------------------------------------------------------ *
 * Esquemas Zod (los usa la API; el formulario de Ajustes puede reusarlos)
 * ------------------------------------------------------------------ */

const shortcutSchema = z.preprocess(
  (v) => (typeof v === "string" ? normalizeShortcut(v) : v),
  z
    .string()
    .regex(
      QUICK_REPLY_LIMITS.shortcutPattern,
      "El atajo admite solo a-z, 0-9, guion y guion bajo (1 a 32)"
    )
);

const fields = {
  shortcut: shortcutSchema,
  title: z.string().trim().min(1).max(QUICK_REPLY_LIMITS.titleMax),
  body: z.string().trim().min(1).max(QUICK_REPLY_LIMITS.bodyMax),
  position: z.number().int().min(0),
};

/** `POST /api/quick-replies` (`QuickReplyCreateBody`). */
export const quickReplyCreateSchema = z.object({
  shortcut: fields.shortcut,
  title: fields.title,
  body: fields.body,
  position: fields.position.optional(),
});

/** `PATCH /api/quick-replies/[id]` (`QuickReplyPatchBody`, al menos un campo). */
export const quickReplyPatchSchema = z
  .object({
    shortcut: fields.shortcut.optional(),
    title: fields.title.optional(),
    body: fields.body.optional(),
    position: fields.position.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Envía al menos un campo",
  });
