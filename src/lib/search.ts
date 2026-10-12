/**
 * Coincidencia de búsqueda tolerante, compartida por Bandeja y Contactos.
 *
 * Dos reglas nacidas de uso real:
 * 1. Sin acentos ni mayúsculas — "jose" encuentra a "José".
 * 2. El teléfono se compara por DÍGITOS: la UI lo pinta "+52 462 134 9768" y
 *    la BD lo guarda "524621349768", así que teclear el número tal como se ve
 *    (o pegarlo con espacios/guiones/paréntesis) no encontraba nada.
 *
 * 06: la regla de verdad es la del SQL (`contactSearchSql`); `matchesQuery`
 * es su espejo exacto (tests/unit/search-parity.test.ts).
 */

const DIACRITICS = /[̀-ͯ]/g;

export function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(DIACRITICS, "");
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Tabla de acentos del `translate()` de la búsqueda SQL
 * (`src/server/search.ts`, sin depender de la extensión `unaccent`). Vive
 * aquí para que el espejo del cliente use EXACTAMENTE la misma.
 */
export const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
export const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

const UNACCENT_MAP = new Map(
  Array.from(UNACCENT_FROM, (ch, i) => [ch, UNACCENT_TO[i] ?? ch] as const)
);

/**
 * Espejo en JS de `lower(translate(col, UNACCENT_FROM, UNACCENT_TO))`: quita
 * SOLO los acentos de la tabla y baja a minúsculas carácter por carácter
 * (como `lower()` de Postgres; "İ" → "i", no "i̇" como `toLowerCase`). No usa
 * NFD a propósito: la columna en SQL no se descompone, así que "Šime" o un
 * acento ya combinado ("e" + U+0301) no se pliegan en el servidor y tampoco
 * deben plegarse aquí.
 */
export function foldLikeSql(value: string): string {
  let out = "";
  for (const ch of value) {
    const lower = (UNACCENT_MAP.get(ch) ?? ch).toLowerCase();
    out += Array.from(lower).length === 1 ? lower : (Array.from(lower)[0] ?? lower);
  }
  return out;
}

/**
 * Mínimo de dígitos para tratar la consulta como teléfono: un "1" suelto
 * emparejaría con medio directorio.
 */
const MIN_PHONE_DIGITS = 3;

export function matchesQuery(
  query: string,
  fields: { text?: (string | null | undefined)[]; phone?: string | null }
): boolean {
  const q = normalizeText(query.trim());
  if (!q) return true;

  // El texto se pliega como lo pliega el SQL (`contactSearchSql`), no con
  // NFD: el servidor manda, y este espejo decide si una fila que llega por
  // SSE entra en la lista filtrada.
  const inText = (fields.text ?? []).some(
    (value) => value != null && foldLikeSql(value).includes(q)
  );
  if (inText) return true;

  const queryDigits = digitsOnly(query);
  if (queryDigits.length < MIN_PHONE_DIGITS || !fields.phone) return false;
  return digitsOnly(fields.phone).includes(queryDigits);
}
