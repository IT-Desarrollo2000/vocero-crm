/**
 * 031 — A dónde volver después de iniciar sesión.
 *
 * El link de la guía (`/ayuda`) llega por WhatsApp a gente sin sesión: el
 * login tiene que devolverla ahí y no a la Bandeja. Pero `?next=` lo escribe
 * cualquiera, así que solo se acepta una ruta INTERNA; todo lo demás
 * (`//evil.com`, `https://…`, `/\evil.com`, codificaciones de lo mismo) cae
 * en `/inbox`. Sin esto, el login sería una redirección abierta.
 *
 * Puro y sin dependencias: lo usan el layout `(app)` (servidor) y el login
 * (cliente).
 */

export const DEFAULT_NEXT = "/inbox";

/** Cabecera de petición donde `src/middleware.ts` deja la ruta pedida. */
export const VOCERO_PATH_HEADER = "x-vocero-path";

/** Un `next` más largo que esto no es una ruta de la app. */
const MAX_NEXT_LENGTH = 2048;

/** Caracteres de control (incluye tab, salto de línea y DEL). */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Rutas a las que no tiene sentido volver: el propio login y la API. */
const BLOCKED_PREFIXES = ["/login", "/api"];

function isSafe(path: string): boolean {
  if (!path.startsWith("/")) return false;
  // `//host` y `/\host` los navegadores los leen como otra web.
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (CONTROL_CHARS.test(path)) return false;
  if (/\s/.test(path.charAt(1))) return false;
  const lower = path.toLowerCase();
  return !BLOCKED_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Devuelve `raw` tal cual si es una ruta interna segura; si no, `/inbox`.
 * Valida el texto crudo Y su versión decodificada una vez: `/%2F%2Fevil.com`
 * no debe colarse como `//evil.com`.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_NEXT;
  if (raw.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_NEXT;
  }
  return isSafe(raw) && isSafe(decoded) ? raw : DEFAULT_NEXT;
}

/**
 * Ruta del login para quien llegó sin sesión a `rawPath` (la cabecera
 * `x-vocero-path` del middleware). A la Bandeja no hace falta `next`.
 */
export function loginPathFor(rawPath: string | null | undefined): string {
  const next = safeNextPath(rawPath);
  return next === DEFAULT_NEXT ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
