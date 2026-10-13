/**
 * Mensajes de "Mi cuenta" (dev-tasks/00, RF-00-16). Lógica pura, sin React:
 * traduce los errores de Better Auth a algo que el usuario entienda y valida
 * el formulario de contraseña antes de llamar a la API.
 */

export const MIN_PASSWORD_LENGTH = 8;

type AuthError = { code?: string; status?: number } | null | undefined;

const TOO_SHORT = `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;

export function passwordChangeError(err: AuthError): string {
  if (err?.status === 429) return "Demasiados intentos. Espera unos minutos.";
  switch (err?.code) {
    case "INVALID_PASSWORD":
      return "La contraseña actual no es correcta.";
    case "PASSWORD_TOO_SHORT":
      return TOO_SHORT;
    case "PASSWORD_TOO_LONG":
      return "La nueva contraseña es demasiado larga.";
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "Tu cuenta no tiene una contraseña propia que cambiar.";
    default:
      return "No se pudo cambiar la contraseña. Inténtalo de nuevo.";
  }
}

/** Valida en el cliente; `null` = se puede enviar. */
export function validatePasswordChange({
  current,
  next,
  confirm,
}: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (!current) return "Escribe tu contraseña actual.";
  if (next.length < MIN_PASSWORD_LENGTH) return TOO_SHORT;
  if (next !== confirm) return "La confirmación no coincide con la nueva contraseña.";
  if (next === current) return "La nueva contraseña debe ser distinta de la actual.";
  return null;
}
