import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardarraíl de migraciones: la MISMA comprobación que `scripts/migrate.mjs`
 * hace al ARRANCAR el contenedor (fork agenciaev, esquema `vocero`).
 *
 * `migrate.mjs` desqualifica `REFERENCES "public"."` y después aborta el
 * arranque si en alguna línea queda `"public".` (o `REFERENCES public.`).
 * Un simple comentario con `"public".` en una migración nueva basta para que
 * producción no arranque — ya pasó una vez. Aquí se detecta en CI, antes del
 * deploy.
 *
 * Si cambias las expresiones de `migrate.mjs`, cámbialas aquí también (el
 * último test lo vigila).
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DRIZZLE = path.join(ROOT, "drizzle");
const MIGRATE = path.join(ROOT, "scripts", "migrate.mjs");

// Réplica exacta de `prepararMigracionesAisladas` (scripts/migrate.mjs).
const DESQUALIFICAR = /REFERENCES "public"\."/g;
const RESIDUO = /"public"\s*\./;
const RESIDUO_SIN_COMILLAS = /\bREFERENCES\s+public\s*\./i;

function residuo(sql: string): { linea: number; texto: string } | null {
  const transformado = sql.replace(DESQUALIFICAR, 'REFERENCES "');
  const lineas = transformado.split(/\r?\n/);
  const i = lineas.findIndex(
    (l) => RESIDUO.test(l) || RESIDUO_SIN_COMILLAS.test(l)
  );
  return i === -1 ? null : { linea: i + 1, texto: (lineas[i] ?? "").trim() };
}

describe("guardarraíl: ninguna migración tumba el arranque por `public`", () => {
  const archivos = readdirSync(DRIZZLE)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("hay migraciones que revisar", () => {
    expect(archivos.length).toBeGreaterThan(0);
  });

  for (const archivo of archivos) {
    it(`${archivo}: sin referencias a \`public\` tras desqualificar`, () => {
      const r = residuo(readFileSync(path.join(DRIZZLE, archivo), "utf8"));
      expect(r, r ? `línea ${r.linea}: ${r.texto}` : "").toBeNull();
    });
  }

  it("la réplica detecta lo que abortaría el arranque", () => {
    expect(residuo('ALTER TABLE "a" ADD CONSTRAINT x FOREIGN KEY ("u") REFERENCES "public"."user"("id");')).toBeNull();
    expect(residuo('-- ojo con "public"."ficha_event"')).not.toBeNull();
    expect(residuo("ALTER TABLE a ADD FOREIGN KEY (u) REFERENCES public.user(id);")).not.toBeNull();
    expect(residuo('CREATE INDEX x ON "public" . "t" (a);')).not.toBeNull();
  });

  it("las expresiones siguen siendo las de scripts/migrate.mjs", () => {
    const src = readFileSync(MIGRATE, "utf8");
    expect(src).toContain('/REFERENCES "public"\\."/g');
    expect(src).toContain('/"public"\\s*\\./');
    expect(src).toContain("/\\bREFERENCES\\s+public\\s*\\./i");
  });
});
