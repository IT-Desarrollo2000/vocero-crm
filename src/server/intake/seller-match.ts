/**
 * 036 — El vendedor que anotó el lead en el Excel del evento → la persona del
 * equipo a quien se le asigna la conversación.
 *
 * La columna «Vendedor» la escribe una persona a mano («Mariana», «mariana
 * lópez», «MARIANA  LOPEZ»), así que se compara normalizado: sin acentos, en
 * minúsculas, espacios colapsados. Solo dos reglas, a propósito estrictas
 * (asignarle un prospecto a la persona equivocada es peor que dejarlo sin
 * asignar):
 *
 *  1. nombre completo igual → esa persona (si hubiera dos con el mismo nombre
 *     completo, «ambiguo»);
 *  2. si no, el texto es UNA palabra igual al PRIMER nombre de exactamente
 *     una persona → esa persona; de varias → «ambiguo».
 *
 * Nada más (ni apellidos sueltos, ni prefijos, ni parecidos).
 */

export type SellerMember = { userId: string; name: string };

export type SellerMatch =
  | { kind: "match"; userId: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/**
 * Lo que el endpoint responde en `assignment` (solo si vino `seller`):
 * - `asignado`: la conversación quedó (o ya estaba) con esa persona;
 * - `ya_asignada`: otra persona ya la tenía — nunca se le quita;
 * - `vendedor_no_encontrado`: nadie del equipo con ese nombre;
 * - `ambiguo`: el nombre corresponde a más de una persona;
 * - `error`: falló la consulta; el lead entró igual, sin asignar.
 */
export type SellerAssignment =
  | "asignado"
  | "ya_asignada"
  | "vendedor_no_encontrado"
  | "ambiguo"
  | "error";

/** trim, minúsculas, sin acentos (NFD), espacios colapsados. */
export function normalizePersonName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Pura: resuelve el texto del Excel contra los miembros del equipo. */
export function matchSeller(
  seller: string,
  members: readonly SellerMember[]
): SellerMatch {
  const wanted = normalizePersonName(seller);
  if (!wanted) return { kind: "none" };
  const norm = members.map((m) => ({
    userId: m.userId,
    name: normalizePersonName(m.name),
  }));

  const exact = norm.filter((m) => m.name === wanted);
  if (exact.length === 1) return { kind: "match", userId: exact[0]!.userId };
  if (exact.length > 1) return { kind: "ambiguous" };

  if (wanted.includes(" ")) return { kind: "none" };
  const byFirst = norm.filter((m) => m.name.split(" ")[0] === wanted);
  if (byFirst.length === 1) return { kind: "match", userId: byFirst[0]!.userId };
  if (byFirst.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}
