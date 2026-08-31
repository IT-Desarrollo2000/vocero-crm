/**
 * Migraciones al ARRANQUE del contenedor (no en pre-deploy: el pre-deploy de
 * plataformas como Coolify corre en el contenedor viejo). Se bundlea con
 * esbuild dentro de la imagen y corre antes de `node server.js`.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL no está definida");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? path.join(here, "drizzle");

/**
 * FORK agenciaev — desqualifica el esquema de las claves foráneas.
 *
 * Vocero vive aislado en el esquema `vocero` de una BD compartida con el
 * proyecto agenciaev (ver NOTAS-FORK.md). Los `CREATE TABLE` que genera
 * drizzle-kit vienen sin calificar y caen bien por `search_path`, pero las FK
 * traen el esquema cableado:
 *
 *   ALTER TABLE "account" ADD CONSTRAINT ...
 *     FOREIGN KEY ("user_id") REFERENCES "public"."user"("id");
 *
 * Contra Supabase eso falla con `relation "public.user" does not exist` y deja
 * la migración a medias. Reescribimos `REFERENCES "public"."` → `REFERENCES "`
 * para que resuelvan por `search_path`, igual que los `CREATE TABLE`.
 * Se desqualifica (en vez de reescribir a `"vocero"."`) para que funcione con
 * cualquier nombre de esquema.
 *
 * `readMigrationFiles()` lee los .sql del disco, así que hay que transformar
 * ANTES de llamar a `migrate()`: se escriben copias en un directorio temporal.
 * Va en `os.tmpdir()` y no dentro de /app porque el contenedor puede montar el
 * filesystem de la app en solo lectura.
 *
 * Nota: drizzle hashea el CONTENIDO de cada migración para
 * `__drizzle_migrations`. La transformación es determinista, así que el hash es
 * estable entre arranques y no provoca re-aplicaciones.
 */
function prepararMigracionesAisladas(origen) {
  const destino = path.join(os.tmpdir(), "vocero-migraciones-agenciaev");
  // Idempotente: esto corre en CADA arranque del contenedor.
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });

  // `readMigrationFiles()` arranca por meta/_journal.json: sin él no encuentra
  // ninguna migración y no aplicaría nada.
  fs.cpSync(path.join(origen, "meta"), path.join(destino, "meta"), {
    recursive: true,
  });

  // Red de seguridad: si tras transformar queda algún `"public".`, upstream
  // introdujo una forma de calificación que no anticipamos. Abortamos ruidoso:
  // es mucho mejor no arrancar que crear tablas a medias en otro esquema.
  const RESIDUO = /"public"\s*\./;
  // Misma idea para la variante sin comillas. Se acota a `REFERENCES` para no
  // saltar por un simple comentario que mencione "public.".
  const RESIDUO_SIN_COMILLAS = /\bREFERENCES\s+public\s*\./i;

  const archivos = fs
    .readdirSync(origen)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const archivo of archivos) {
    const original = fs.readFileSync(path.join(origen, archivo), "utf8");
    let reemplazos = 0;
    const transformado = original.replace(
      /REFERENCES "public"\."/g,
      () => (reemplazos++, 'REFERENCES "')
    );

    const lineas = transformado.split(/\r?\n/);
    const i = lineas.findIndex(
      (l) => RESIDUO.test(l) || RESIDUO_SIN_COMILLAS.test(l)
    );
    if (i !== -1) {
      console.error(
        `[migrate] ABORTADO: quedó una referencia a \`public\` sin desqualificar.\n` +
          `  archivo: ${archivo}\n` +
          `  línea ${i + 1}: ${lineas[i].trim()}\n` +
          `  Upstream introdujo una forma de calificar el esquema que la\n` +
          `  transformación del fork no cubre. Ver NOTAS-FORK.md §3.4.`
      );
      process.exit(1);
    }

    fs.writeFileSync(path.join(destino, archivo), transformado);
    // Cero reemplazos NO es error: hay migraciones sin FKs.
    console.log(`[migrate] ${archivo}: ${reemplazos} FK desqualificadas`);
  }

  return destino;
}

// Determinista y sin dependencia de la BD: se hace UNA vez, fuera del bucle de
// reintentos de abajo.
const migrationsFolderAislado = prepararMigracionesAisladas(migrationsFolder);

const maxAttempts = 15;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  // FORK agenciaev: mismo search_path que el cliente de la app (src/lib/db).
  // La BD es compartida con agenciaev y Vocero vive aislado en el esquema
  // `vocero`; sin esto las migraciones crearían/alterarían tablas en `public`.
  // `public` se omite A PROPÓSITO para no tocar por accidente el otro proyecto.
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: "vocero, extensions" },
  });
  try {
    await migrate(drizzle(sql), { migrationsFolder: migrationsFolderAislado });
    console.log("[migrate] migraciones aplicadas");
    await sql.end();
    process.exit(0);
  } catch (err) {
    await sql.end().catch(() => {});
    if (attempt === maxAttempts) {
      console.error("[migrate] falló tras varios intentos:", err);
      process.exit(1);
    }
    console.log(
      `[migrate] BD no lista (intento ${attempt}/${maxAttempts}), reintento en 2s…`
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}
