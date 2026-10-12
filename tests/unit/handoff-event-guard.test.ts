import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardarraíl de la bitácora de escalamientos (05/02-0).
 *
 * `conversation_handoff_event` es append-only y su ÚNICA puerta es
 * `markHandoff` (src/server/inbox/handoff.ts), que inserta en la misma
 * transacción que el UPDATE de `conversation`. Un camino que escale por su
 * cuenta no truena: solo hace que las métricas de 02 subcuenten meses después.
 *
 * Si estás leyendo esto porque el test se puso rojo: no lo relajes — enruta
 * tu escalamiento por `markHandoff()`.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const PUERTA = path.join("server", "inbox", "handoff.ts");

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...archivosTs(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const INSERT = /\.insert\(\s*schema\.conversationHandoffEvent\s*\)/;
const MUTA = /\.(update|delete)\(\s*schema\.conversationHandoffEvent\s*\)/;
// SQL crudo sobre la tabla (sql`...`): también cuenta.
const SQL_CRUDO = /(insert\s+into|update|delete\s+from)\s+"?conversation_handoff_event"?/i;

describe("guardarraíl: bitácora de escalamientos append-only con una sola puerta", () => {
  it("nadie fuera de inbox/handoff.ts inserta en conversation_handoff_event", () => {
    const infractores: string[] = [];
    for (const file of archivosTs(SRC)) {
      if (file.endsWith(PUERTA)) continue;
      const code = readFileSync(file, "utf8");
      if (INSERT.test(code) || SQL_CRUDO.test(code)) {
        infractores.push(path.relative(SRC, file));
      }
    }
    expect(
      infractores,
      `Estos archivos escriben la bitácora sin pasar por markHandoff():\n` +
        infractores.map((f) => `  · ${f}`).join("\n")
    ).toEqual([]);
  });

  it("nadie (ni la puerta) actualiza ni borra filas de la bitácora", () => {
    const infractores: string[] = [];
    for (const file of archivosTs(SRC)) {
      const code = readFileSync(file, "utf8");
      if (MUTA.test(code)) infractores.push(path.relative(SRC, file));
      else if (file.endsWith(PUERTA) && SQL_CRUDO.test(code)) {
        infractores.push(path.relative(SRC, file));
      }
    }
    expect(infractores).toEqual([]);
  });

  it("la puerta sí inserta (el test detectaría el patrón)", () => {
    // Si este test falla, la detección de arriba quedó ciega: alguien
    // reescribió la puerta con otra forma.
    const code = readFileSync(path.join(SRC, PUERTA), "utf8");
    expect(INSERT.test(code)).toBe(true);
  });
});
