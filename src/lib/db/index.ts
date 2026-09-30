import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Cliente de BD único por proceso. En dev, Next recarga módulos: se cachea en
 * globalThis para no agotar conexiones.
 */
const globalForDb = globalThis as unknown as {
  __voceroSql?: ReturnType<typeof postgres>;
};

function createClient() {
  const env = getEnv();
  return postgres(env.DATABASE_URL, {
    max: 10,
    onnotice: () => {},
    // FORK agenciaev: la BD es compartida con el proyecto agenciaev, así que
    // Vocero vive aislado en el esquema `vocero`. Sus tablas se declaran sin
    // calificar, por lo que el aislamiento depende de este search_path.
    // `public` se omite A PROPÓSITO: si estuviera, una tabla que falte en
    // `vocero` se resolvería en silencio contra la del otro proyecto.
    connection: { search_path: "vocero, extensions" },
  });
}

export function getSql() {
  if (!globalForDb.__voceroSql) globalForDb.__voceroSql = createClient();
  return globalForDb.__voceroSql;
}

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!cachedDb) cachedDb = drizzle(getSql(), { schema });
  return cachedDb;
}

export { schema };
