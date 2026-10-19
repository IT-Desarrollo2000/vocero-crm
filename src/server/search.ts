import { or, sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { UNACCENT_FROM, UNACCENT_TO, digitsOnly, foldLikeSql } from "@/lib/search";

/**
 * Búsqueda tolerante en SQL, espejo de `matchesQuery` del cliente
 * (`src/lib/search.ts`). Compartida por Contactos y la Bandeja (06), que
 * hacen `join` con `contact`:
 * - nombre (o nombre de perfil del canal, 022) sin acentos ni mayúsculas
 *   (`translate`, sin depender de la
 *   extensión `unaccent`, que exigiría privilegios en la BD; la tabla vive en
 *   `src/lib/search.ts` para que el espejo del cliente use la misma);
 * - teléfono por DÍGITOS, para poder teclearlo como se ve ("+52 462 134…").
 */

/** Un dígito suelto barrería el directorio entero: mínimo 3. */
const MIN_PHONE_DIGITS = 3;

/**
 * Condición sobre `contact.name` / `contact.profile_name` / `contact.phone`
 * para la consulta `q`, o
 * `undefined` si `q` viene vacía (no filtra). Úsala dentro de `scoped(...)`.
 */
export function contactSearchSql(q: string | null | undefined): SQL | undefined {
  const query = q?.trim();
  if (!query) return undefined;
  const qDigits = digitsOnly(query);
  // El patrón se pliega EXACTAMENTE como la columna (`foldLikeSql` ≡
  // `lower(translate(...))`), no con NFD: así "šime" encuentra "Šime" (la
  // tabla no lo pliega en ningún lado). Comodines de LIKE escapados para que
  // un "%" tecleado no liste todo.
  const qLike = foldLikeSql(query).replace(/[\\%_]/g, "\\$&");
  return or(
    sql`lower(translate(${schema.contact.name}, ${UNACCENT_FROM}, ${UNACCENT_TO}))
        like ${`%${qLike}%`}`,
    // 022: el nickname original sigue encontrándose tras renombrar. NULL =
    // desconocido → coalesce para que el OR no arrastre un NULL.
    sql`lower(translate(coalesce(${schema.contact.profileName}, ''), ${UNACCENT_FROM}, ${UNACCENT_TO}))
        like ${`%${qLike}%`}`,
    qDigits.length >= MIN_PHONE_DIGITS
      ? sql`regexp_replace(coalesce(${schema.contact.phone}, ''), '\\D', '', 'g')
            like ${`%${qDigits}%`}`
      : undefined
  );
}
