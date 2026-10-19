import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { matchesQuery } from "@/lib/search";
import { contactSearchSql } from "@/server/search";

/**
 * 06 — Paridad de la búsqueda cliente/servidor. La Bandeja filtra en el
 * servidor con `contactSearchSql` y usa `matchesQuery` como ESPEJO para
 * decidir si una fila que llega por SSE entra en la lista filtrada. Si el
 * espejo fuera más estricto escondería filas que el servidor devolvió; si
 * fuera más amplio, una fila aparecería por SSE y desaparecería al recargar.
 *
 * El lado SQL se evalúa interpretando, con su semántica de Postgres, el SQL y
 * los parámetros que genera `contactSearchSql` de verdad (translate + lower +
 * LIKE con `\` de escape; regexp_replace '\D'). Los casos "golden" de abajo
 * se midieron contra Postgres 16 (en_US.utf8) en la BD aislada de E2E.
 */

const dialect = new PgDialect();

/** `lower()` de Postgres: mapeo simple carácter a carácter ("İ" → "i"). */
function pgLower(value: string): string {
  return Array.from(value, (ch) => Array.from(ch.toLowerCase())[0] ?? ch).join("");
}

function pgTranslate(value: string, from: string, to: string): string {
  const f = Array.from(from);
  const t = Array.from(to);
  return Array.from(value, (ch) => {
    const i = f.indexOf(ch);
    return i === -1 ? ch : (t[i] ?? "");
  }).join("");
}

/** LIKE de Postgres con el escape por defecto (`\`). */
function pgLike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "u").test(value);
}

type SearchContact = { name: string; phone: string | null; profileName?: string | null };

/** Evalúa el predicado que `contactSearchSql(q)` manda a Postgres. */
function serverMatches(q: string, contact: SearchContact): boolean {
  const cond = contactSearchSql(q);
  if (!cond) return true; // q vacía: no filtra
  const { sql, params } = dialect.sqlToQuery(cond);
  expect(sql).toMatch(/lower\(translate\("contact"\."name", \$1, \$2\)\)\s+like \$3/);
  // 022: el nombre de perfil, con coalesce (NULL = desconocido).
  expect(sql).toMatch(
    /lower\(translate\(coalesce\("contact"\."profile_name", ''\), \$4, \$5\)\)\s+like \$6/
  );
  const [from, to, namePattern, pFrom, pTo, profilePattern, phonePattern] = params as string[];
  const byName = pgLike(pgLower(pgTranslate(contact.name, from!, to!)), namePattern!);
  const byProfile = pgLike(
    pgLower(pgTranslate(contact.profileName ?? "", pFrom!, pTo!)),
    profilePattern!
  );
  if (phonePattern === undefined) {
    expect(sql).not.toContain("regexp_replace");
    return byName || byProfile;
  }
  expect(sql).toMatch(/regexp_replace\(coalesce\("contact"\."phone", ''\), '\\D', '', 'g'\)\s+like \$7/);
  const digits = (contact.phone ?? "").replace(/\D/g, "");
  return byName || byProfile || pgLike(digits, phonePattern);
}

/** El espejo, con los mismos campos que pasa la Bandeja (helpers.ts). */
function clientMatches(q: string, c: SearchContact): boolean {
  return matchesQuery(q, { text: [c.name, c.profileName], phone: c.phone });
}

const CONTACTS: SearchContact[] = [
  { name: "José Pérez", phone: "524621349768" },
  // 022: renombrado por el equipo; el nickname del canal sigue buscándose.
  { name: "Lucía Ramírez", phone: "5213331112222", profileName: "Dios es amor 🙏" },
  { name: "Pedro", phone: null, profileName: "Ñoñito Güero" },
  { name: "Marta", phone: null, profileName: null },
  { name: "JOSÉ ÑANDÚ", phone: null },
  { name: "Ñoño Güemes", phone: "+52 (477) 605-3008" },
  { name: "Müller Über", phone: "5215550001111" },
  { name: "José Decompuesto", phone: null },
  { name: "100% Real_Name", phone: "5500" },
  { name: "Back\\slash", phone: null },
  { name: "Šime Ćorić", phone: null },
  { name: "Ýago Øster", phone: null },
  { name: "İstanbul", phone: null },
  { name: "Ana", phone: "5299" },
];

const QUERIES = [
  "jose", "JOSÉ", "Jose", "ñandu", "nandu", "ÑANDÚ", "guemes", "güemes", "muller", "über",
  "uber", "decompuesto", "josé decomp", "%", "_", "100%", "real_name", "real%name", "\\",
  "back\\", "sime", "šime", "coric", "yago", "ýago", "oster", "istanbul", "+52 462 134",
  "462-134-9768", "(477) 605", "4776053008", "52", "529", "55 00", "   ", "ana", "a_a", "%%",
  "dios", "DIOS ES", "amor", "lucia", "nonito", "ñoñito", "guero", "marta", "333 111",
];

describe("búsqueda: el espejo del cliente ≡ el SQL del servidor", () => {
  it("coinciden en todos los casos (acentos, ñ, ü, mayúsculas, teléfono, % y _)", () => {
    const diffs: string[] = [];
    for (const q of QUERIES) {
      for (const c of CONTACTS) {
        const client = clientMatches(q, c);
        const server = serverMatches(q, c);
        if (client !== server) diffs.push(`${JSON.stringify(q)} vs ${c.name}: cliente ${client}, servidor ${server}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  // Medidos contra Postgres (BD aislada :5433). Anclan el intérprete de arriba.
  it.each([
    ["jose", "JOSÉ ÑANDÚ", null, true],
    ["ñandu", "JOSÉ ÑANDÚ", null, true],
    ["guemes", "Ñoño Güemes", null, true],
    ["uber", "Müller Über", null, true],
    ["istanbul", "İstanbul", null, true],
    ["(477) 605", "Ñoño Güemes", "+52 (477) 605-3008", true],
    ["100%", "100% Real_Name", "5500", true],
    ["real_name", "100% Real_Name", "5500", true],
    ["%", "José Pérez", "524621349768", false],
    ["_", "Ana", "5299", false],
    ["real%name", "100% Real_Name", "5500", false],
    ["a_a", "Ana", "5299", false],
    // Fuera de la tabla de `translate`: el servidor NO los pliega, el espejo tampoco.
    ["sime", "Šime Ćorić", null, false],
    // …pero la consulta se pliega como la columna: con el mismo carácter, sí.
    ["šime", "Šime Ćorić", null, true],
    ["ŠIME", "Šime Ćorić", null, true],
    ["ýago", "Ýago Øster", null, true],
    ["yago", "Ýago Øster", null, false],
    ["josé decomp", "José Decompuesto", null, false],
  ] as const)("%j en %j → %s (Postgres)", (q, name, phone, expected) => {
    expect(serverMatches(q, { name, phone })).toBe(expected);
    expect(matchesQuery(q, { text: [name], phone })).toBe(expected);
  });

  // 022: renombrar no pierde el nickname, y un nombre de perfil desconocido
  // (NULL) no encuentra nada por sí mismo.
  it.each([
    ["dios", { name: "Lucía Ramírez", phone: null, profileName: "Dios es amor" }, true],
    ["lucia", { name: "Lucía Ramírez", phone: null, profileName: "Dios es amor" }, true],
    ["guero", { name: "Pedro", phone: null, profileName: "Ñoñito Güero" }, true],
    ["%", { name: "Pedro", phone: null, profileName: "Ñoñito Güero" }, false],
    ["dios", { name: "Marta", phone: null, profileName: null }, false],
  ] as const)("perfil: %j en %j → %s", (q, c, expected) => {
    expect(serverMatches(q, c)).toBe(expected);
    expect(clientMatches(q, c)).toBe(expected);
  });
});
