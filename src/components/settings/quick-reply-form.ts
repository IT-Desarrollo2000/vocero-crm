import {
  QUICK_REPLY_LIMITS,
  QUICK_REPLY_VARS,
  findUnknownVars,
  normalizeShortcut,
} from "@/lib/quick-replies";

/**
 * 09/029 — Validación y mensajes del formulario de respuestas rápidas,
 * compartidos por Ajustes → Respuestas rápidas y el diálogo del compositor
 * (`QuickReplyDialog`). Sin React: solo funciones puras + el parseo del error.
 */

/** Ayuda de cada variable, en el orden de `QUICK_REPLY_VARS`. */
export const QUICK_REPLY_VAR_HELP: Record<(typeof QUICK_REPLY_VARS)[number], string> = {
  nombre: "primer nombre del cliente",
  nombre_completo: "nombre completo del cliente",
  vendedor: "tu nombre o el de quien envía",
  negocio: "nombre de tu Marca",
  producto: "nombre del producto ligado (solo si la respuesta tiene producto)",
};

/** Variables que ofrece un formulario sin producto (sin `{{producto}}`). */
export const TEXT_ONLY_VARS = QUICK_REPLY_VARS.filter((v) => v !== "producto");

type ApiError = { error?: { code?: string; message?: string } } | null;

/** Mensaje del servidor si lo hay; si no, uno por código. */
export async function quickReplyErrorMessage(res: Response | null, fallback: string) {
  if (!res) return "Sin conexión con el servidor";
  if (res.status === 501) {
    return "Las respuestas rápidas aún no están disponibles en este servidor.";
  }
  const data = (await res.json().catch(() => null)) as ApiError;
  switch (data?.error?.code) {
    case "duplicate_shortcut":
      return data.error.message ?? "Ya existe una respuesta con ese atajo.";
    case "unknown_variable":
      return data.error.message ?? "El texto usa una variable desconocida.";
    case "not_found":
      return "Esa respuesta ya no existe. Recarga la página.";
    case "forbidden":
      return data.error.message ?? "No tienes permiso para hacer esto.";
    default:
      return data?.error?.message ?? fallback;
  }
}

/** Validación previa al envío (el servidor valida igual). null = válido. */
export function validateQuickReplyForm(form: {
  shortcut: string;
  title: string;
  body: string;
  /** "" = sin producto. */
  productId?: string;
}): string | null {
  const productId = form.productId ?? "";
  const shortcut = normalizeShortcut(form.shortcut);
  if (!QUICK_REPLY_LIMITS.shortcutPattern.test(shortcut)) {
    return "El atajo lleva de 1 a 32 caracteres: letras minúsculas, números, - o _.";
  }
  const title = form.title.trim();
  if (!title || title.length > QUICK_REPLY_LIMITS.titleMax) {
    return `El título lleva de 1 a ${QUICK_REPLY_LIMITS.titleMax} caracteres.`;
  }
  // 019: el texto puede ir vacío solo si la respuesta adjunta un producto.
  if ((!form.body.trim() && !productId) || form.body.length > QUICK_REPLY_LIMITS.bodyMax) {
    return productId
      ? `El texto lleva hasta ${QUICK_REPLY_LIMITS.bodyMax} caracteres.`
      : `El texto lleva de 1 a ${QUICK_REPLY_LIMITS.bodyMax} caracteres (puede ir vacío si eliges un producto).`;
  }
  const unknown = findUnknownVars(form.body, { product: !!productId });
  if (unknown.length > 0) {
    return `Variable desconocida: ${unknown.map((v) => `{{${v}}}`).join(", ")}`;
  }
  return null;
}
