import { count } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Registro público cerrado tras la primera organización (FR-060), salvo la
 * variable de escape ALLOW_SIGNUP=true. Las cuentas de equipo las crea el
 * propietario (bypass interno del gate).
 */
export async function isPublicSignupAllowed(): Promise<boolean> {
  if (process.env.ALLOW_SIGNUP === "true") return true;
  return !(await organizationExists());
}

/** La instancia ya tiene al menos una organización (primer registro hecho). */
export async function organizationExists(): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ n: count() }).from(schema.organization);
  return (rows[0]?.n ?? 0) > 0;
}
