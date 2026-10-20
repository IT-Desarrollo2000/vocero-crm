import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  APPOINTMENT_TYPE_SEED,
  matchTypeByName,
  pickFallbackType,
  validateTypeInput,
  type AppointmentTypeInput,
} from "@/lib/agenda-types";
import type { AgendaDb } from "@/server/agenda/db";

/**
 * 023 — Catálogo de tipos de cita por organización.
 *
 * Siembra PEREZOSA: una organización sin ningún tipo recibe la siembra al
 * primer uso. Es idempotente aunque dos requests la disparen a la vez: el
 * UNIQUE (org, seed_key) + `onConflictDoNothing` deja una sola copia.
 *
 * Un tipo se desactiva, no se borra: las citas viejas lo referencian.
 */

export type AppointmentType = typeof schema.appointmentType.$inferSelect;

export class AppointmentTypeError extends Error {
  code: "invalid" | "not_found";
  constructor(code: "invalid" | "not_found", message: string) {
    super(message);
    this.name = "AppointmentTypeError";
    this.code = code;
  }
}

export async function listTypes(
  organizationId: string,
  opts: { includeInactive?: boolean } = {},
  db: AgendaDb = getDb()
): Promise<AppointmentType[]> {
  let rows = await selectAll(organizationId, db);
  if (rows.length === 0) {
    await seedTypes(organizationId, db);
    rows = await selectAll(organizationId, db);
  }
  return opts.includeInactive ? rows : rows.filter((t) => t.active);
}

async function selectAll(
  organizationId: string,
  db: AgendaDb
): Promise<AppointmentType[]> {
  return db
    .select()
    .from(schema.appointmentType)
    .where(scoped(schema.appointmentType.organizationId, organizationId))
    .orderBy(
      asc(schema.appointmentType.position),
      asc(schema.appointmentType.createdAt)
    );
}

/** Idempotente: re-ejecutarla (o correrla dos veces a la vez) no duplica. */
export async function seedTypes(
  organizationId: string,
  db: AgendaDb = getDb()
): Promise<void> {
  await db
    .insert(schema.appointmentType)
    .values(
      APPOINTMENT_TYPE_SEED.map((s) => ({
        id: newId("appointmentType"),
        organizationId,
        name: s.name,
        durationMinutes: s.durationMinutes,
        exclusive: s.exclusive,
        position: s.position,
        seedKey: s.seedKey,
      }))
    )
    .onConflictDoNothing({
      target: [
        schema.appointmentType.organizationId,
        schema.appointmentType.seedKey,
      ],
    });
}

/** El tipo, activo o no; null si no existe o es de otra organización. */
export async function getType(
  organizationId: string,
  typeId: string,
  db: AgendaDb = getDb()
): Promise<AppointmentType | null> {
  const rows = await db
    .select()
    .from(schema.appointmentType)
    .where(
      scoped(
        schema.appointmentType.organizationId,
        organizationId,
        eq(schema.appointmentType.id, typeId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createType(
  organizationId: string,
  input: {
    name: string;
    durationMinutes: number;
    exclusive?: boolean;
    position?: number;
  }
): Promise<AppointmentType> {
  const checked = validateTypeInput(input);
  if (!checked.ok) throw new AppointmentTypeError("invalid", checked.message);
  const v = checked.value;

  const db = getDb();
  let position = v.position;
  if (position === undefined) {
    // Al final de la lista (siembra incluida: se dispara si no había nada).
    const all = await listTypes(organizationId, { includeInactive: true }, db);
    position = all.reduce((max, t) => Math.max(max, t.position + 1), 0);
  }
  const inserted = await db
    .insert(schema.appointmentType)
    .values({
      id: newId("appointmentType"),
      organizationId,
      name: v.name!,
      durationMinutes: v.durationMinutes!,
      exclusive: v.exclusive ?? false,
      position,
    })
    .returning();
  return inserted[0]!;
}

export async function updateType(
  organizationId: string,
  typeId: string,
  input: AppointmentTypeInput
): Promise<AppointmentType> {
  const checked = validateTypeInput(input);
  if (!checked.ok) throw new AppointmentTypeError("invalid", checked.message);

  const db = getDb();
  const rows = await db
    .update(schema.appointmentType)
    .set({ ...checked.value, updatedAt: new Date() })
    .where(
      scoped(
        schema.appointmentType.organizationId,
        organizationId,
        eq(schema.appointmentType.id, typeId)
      )
    )
    .returning();
  if (!rows[0]) {
    throw new AppointmentTypeError("not_found", "Tipo de cita no encontrado");
  }
  return rows[0];
}

/**
 * El tipo ACTIVO que pidió el modelo o el bot por nombre (exacto normalizado;
 * prefijo solo si es único). null ⇒ preguntar.
 */
export async function resolveTypeByName(
  organizationId: string,
  name: string,
  db: AgendaDb = getDb()
): Promise<AppointmentType | null> {
  return matchTypeByName(await listTypes(organizationId, {}, db), name);
}

/**
 * Tipo por omisión del bot y de las ofertas legacy (A2): el único activo, o
 * el primer activo NO exclusivo. null si no hay. Siembra si hace falta: el
 * bot puede ser el primero en agendar en una organización recién creada.
 */
export async function resolveFallbackType(
  organizationId: string,
  db: AgendaDb = getDb()
): Promise<AppointmentType | null> {
  return pickFallbackType(await listTypes(organizationId, {}, db));
}

/** 023 — Lo que viaja a la UI y al bot (sin `organizationId` ni `seedKey`). */
export type AppointmentTypeDto = {
  id: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  position: number;
  active: boolean;
};

export function appointmentTypeDto(t: AppointmentType): AppointmentTypeDto {
  return {
    id: t.id,
    name: t.name,
    durationMinutes: t.durationMinutes,
    exclusive: t.exclusive,
    position: t.position,
    active: t.active,
  };
}
