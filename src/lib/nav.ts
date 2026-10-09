/**
 * Menú lateral contraído (solo escritorio). Igual que el tema, la preferencia
 * es POR DISPOSITIVO (cookie): el layout la lee en el servidor y el primer
 * pintado ya llega con el ancho correcto, sin parpadeo.
 */

export const NAV_COLLAPSED_COOKIE = "vocero-nav-collapsed";
export const NAV_COLLAPSED_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Solo "1" contrae: cookie ausente o manipulada → expandido. Nunca lanza. */
export function normalizeNavCollapsed(value: string | null | undefined): boolean {
  return value === "1";
}
