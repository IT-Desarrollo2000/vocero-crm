import { or, sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { digitsOnly, normalizeText } from "@/lib/search";

/**
 * Búsqueda tolerante en SQL, espejo de `matchesQuery` del cliente
 * (`src/lib/search.ts`). Compartida por Contactos y la Bandeja (06), que
 * hacen `join` con `contact`:
 * - nombre sin acentos ni mayúsculas (`translate`, sin depender de la
 *   extensión `unaccent`, que exigiría privilegios en la BD);
 * - teléfono por DÍGITOS, para poder teclearlo como se ve ("+52 462 134…").
 */
const UNACCENT_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const UNACCENT_TO = "aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC";

/** Un dígito suelto barrería el directorio entero: mínimo 3. */
const MIN_PHONE_DIGITS = 3;

/**
 * Condición sobre `contact.name` / `contact.phone` para la consulta `q`, o
 * `undefined` si `q` viene vacía (no filtra). Úsala dentro de `scoped(...)`.
 */
export function contactSearchSql(q: string | null | undefined): SQL | undefined {
  const query = q?.trim();
  if (!query) return undefined;
  const qDigits = digitsOnly(query);
  // El patrón viaja normalizado igual que la columna, y con los comodines de
  // LIKE escapados para que un "%" tecleado no liste todo.
  const qLike = normalizeText(query).replace(/[\\%_]/g, "\\$&");
  return or(
    sql`lower(translate(${schema.contact.name}, ${UNACCENT_FROM}, ${UNACCENT_TO}))
        like ${`%${qLike}%`}`,
    qDigits.length >= MIN_PHONE_DIGITS
      ? sql`regexp_replace(coalesce(${schema.contact.phone}, ''), '\\D', '', 'g')
            like ${`%${qDigits}%`}`
      : undefined
  );
}
