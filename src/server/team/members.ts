import { and, asc, eq, sql } from "drizzle-orm";
import { customAlphabet, nanoid } from "nanoid";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeRole, ROLE, type Role } from "@/lib/roles";

/**
 * Gestión de equipo (tarea 00, RF-00-11/12) — solo la invoca el Propietario
 * desde /api/settings/team/*.
 *
 * Invariantes:
 * - La organización tiene siempre ≥ 1 Propietario (varios permitidos, D-00-2).
 *   Toda operación que quita un owner bloquea primero, en la transacción, las
 *   filas owner de la org (`SELECT … FOR UPDATE`): dos degradaciones cruzadas
 *   concurrentes se serializan y la segunda ve un solo owner → `last_owner`.
 * - Nadie se cambia el rol, se da de baja ni se restablece la contraseña a sí
 *   mismo por aquí (`self_change`): para lo propio está "Mi cuenta".
 * - La baja borra la membresía y TODAS las sesiones, pero NO la fila `user`
 *   (D-00-1): conserva la autoría histórica y permite la re-alta.
 */

export type TeamErrorCode =
  | "not_found"
  | "self_change"
  | "last_owner"
  | "duplicate"
  | "invalid";

/** Error de dominio con su status HTTP; las rutas lo traducen con apiError. */
export class TeamError extends Error {
  constructor(
    readonly status: number,
    readonly code: TeamErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export type TeamMember = {
  /** id de la membresía (`member.id`). */
  id: string;
  userId: string;
  role: Role;
  name: string;
  email: string;
  createdAt: Date;
};

type Db = ReturnType<typeof getDb>;
/** Transacción de drizzle (lo que recibe el callback de `db.transaction`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Tarea 09 (RF-09-14): al dar de baja a un miembro, sus conversaciones
 * asignadas vuelven a "sin asignar". Corre DENTRO de la transacción de la
 * baja (si falla, la baja se revierte) y devuelve los ids liberados: quien
 * llama publica `conversation.updated { id }` por cada uno DESPUÉS del commit.
 *
 * Hace falta porque la baja no borra la fila `user` (D-00-1): el
 * `ON DELETE SET NULL` de la FK nunca se dispara por aquí.
 */
export async function onMemberRemoved(
  organizationId: string,
  userId: string,
  tx?: DbTx
): Promise<string[]> {
  const c = schema.conversation;
  const rows = await (tx ?? getDb())
    .update(c)
    .set({ assignedUserId: null, assignedAt: null, updatedAt: new Date() })
    .where(scoped(c.organizationId, organizationId, eq(c.assignedUserId, userId)))
    .returning({ id: c.id });
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ *
 * Frontera de datos: todo lo que la lógica necesita de la BD, dentro de
 * una transacción. Inyectable para probar las guardas sin Postgres.
 * ------------------------------------------------------------------ */

export interface TeamStore {
  /** Bloquea (FOR UPDATE) y devuelve los ids de membresía owner de la org. */
  lockOwnerIds(organizationId: string): Promise<string[]>;
  /** Membresía de la org (bloqueada FOR UPDATE) o null. */
  findMember(organizationId: string, memberId: string): Promise<TeamMember | null>;
  setRole(organizationId: string, memberId: string, role: Role): Promise<void>;
  deleteMember(organizationId: string, memberId: string): Promise<void>;
  /** Borra TODAS las sesiones del usuario (no hay cookieCache: efecto inmediato). */
  deleteSessions(userId: string): Promise<void>;
  /** Fija el hash de la credencial email+contraseña (la crea si no existe). */
  setPasswordHash(userId: string, hash: string): Promise<void>;
  findUserByEmail(email: string): Promise<{ id: string; name: string } | null>;
  /** Inserta la membresía; null si ya existía (choca con member_org_user_uq). */
  insertMember(
    organizationId: string,
    userId: string,
    role: Role
  ): Promise<string | null>;
  updateUserName(userId: string, name: string): Promise<void>;
}

export type TeamDeps = {
  runInTx<T>(fn: (store: TeamStore, tx: DbTx) => Promise<T>): Promise<T>;
  hashPassword(password: string): Promise<string>;
  generatePassword(): string;
  /** Alta de usuario nuevo vía Better Auth (registro interno); devuelve userId. */
  signUp(input: { name: string; email: string; password: string }): Promise<string>;
  /** Libera las conversaciones del usuario (09); devuelve sus ids. */
  onMemberRemoved(organizationId: string, userId: string, tx: DbTx): Promise<string[]>;
};

function drizzleStore(tx: DbTx): TeamStore {
  const m = schema.member;
  return {
    async lockOwnerIds(organizationId) {
      const rows = await tx
        .select({ id: m.id })
        .from(m)
        .where(scoped(m.organizationId, organizationId, eq(m.role, ROLE.owner)))
        .orderBy(asc(m.id))
        .for("update");
      return rows.map((r) => r.id);
    },
    async findMember(organizationId, memberId) {
      const rows = await tx
        .select({
          id: m.id,
          userId: m.userId,
          role: m.role,
          createdAt: m.createdAt,
          name: schema.user.name,
          email: schema.user.email,
        })
        .from(m)
        .innerJoin(schema.user, eq(m.userId, schema.user.id))
        .where(scoped(m.organizationId, organizationId, eq(m.id, memberId)))
        .for("update", { of: m });
      const row = rows[0];
      return row ? { ...row, role: normalizeRole(row.role) } : null;
    },
    async setRole(organizationId, memberId, role) {
      await tx
        .update(m)
        .set({ role })
        .where(scoped(m.organizationId, organizationId, eq(m.id, memberId)));
    },
    async deleteMember(organizationId, memberId) {
      await tx
        .delete(m)
        .where(scoped(m.organizationId, organizationId, eq(m.id, memberId)));
    },
    async deleteSessions(userId) {
      await tx.delete(schema.session).where(eq(schema.session.userId, userId));
    },
    async setPasswordHash(userId, hash) {
      const a = schema.account;
      const updated = await tx
        .update(a)
        .set({ password: hash, updatedAt: new Date() })
        .where(and(eq(a.userId, userId), eq(a.providerId, "credential")))
        .returning({ id: a.id });
      if (updated.length > 0) return;
      // Sin credencial email+contraseña (no debería pasar con altas de
      // Vocero): se crea con la misma forma que deja Better Auth.
      await tx.insert(a).values({
        id: nanoid(32),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hash,
      });
    },
    async findUserByEmail(email) {
      const rows = await tx
        .select({ id: schema.user.id, name: schema.user.name })
        .from(schema.user)
        .where(sql`lower(${schema.user.email}) = lower(${email})`)
        .limit(1);
      return rows[0] ?? null;
    },
    async insertMember(organizationId, userId, role) {
      const rows = await tx
        .insert(m)
        .values({ id: newId("member"), organizationId, userId, role })
        .onConflictDoNothing({ target: [m.organizationId, m.userId] })
        .returning({ id: m.id });
      return rows[0]?.id ?? null;
    },
    async updateUserName(userId, name) {
      await tx
        .update(schema.user)
        .set({ name, updatedAt: new Date() })
        .where(eq(schema.user.id, userId));
    },
  };
}

// Sin caracteres ambiguos (0/O, 1/l/I): se dicta o se copia a mano.
const TEMP_PASSWORD_ALPHABET =
  "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 16 caracteres de 55 símbolos ≈ 92 bits (nanoid usa el CSPRNG del sistema). */
export const generateTemporaryPassword = customAlphabet(
  TEMP_PASSWORD_ALPHABET,
  16
);

const defaultDeps: TeamDeps = {
  runInTx: (fn) => getDb().transaction((tx) => fn(drizzleStore(tx), tx)),
  // Mismo hasher que usa Better Auth al registrar/iniciar sesión.
  hashPassword: async (password) =>
    (await getAuth().$context).password.hash(password),
  generatePassword: () => generateTemporaryPassword(),
  signUp: async (input) => {
    const result = await runInternalSignup(() =>
      getAuth().api.signUpEmail({ body: input })
    );
    return result.user.id;
  },
  onMemberRemoved: (organizationId, userId, tx) =>
    onMemberRemoved(organizationId, userId, tx),
};

function notFound(): TeamError {
  return new TeamError(404, "not_found", "Miembro no encontrado");
}

function selfChange(): TeamError {
  return new TeamError(
    409,
    "self_change",
    "No puedes cambiar tu propio acceso desde aquí; usa Mi cuenta"
  );
}

function lastOwner(): TeamError {
  return new TeamError(
    409,
    "last_owner",
    "La organización debe conservar al menos un Propietario"
  );
}

/** ¿Quitar el rol owner a `target` dejaría la org sin Propietarios? */
function wouldLeaveNoOwner(target: TeamMember, ownerIds: string[]): boolean {
  if (target.role !== ROLE.owner) return false;
  return ownerIds.filter((id) => id !== target.id).length === 0;
}

/** Lista del equipo de la organización (más antiguos primero). */
export async function listMembers(organizationId: string): Promise<TeamMember[]> {
  const rows = await getDb()
    .select({
      id: schema.member.id,
      userId: schema.member.userId,
      role: schema.member.role,
      createdAt: schema.member.createdAt,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(scoped(schema.member.organizationId, organizationId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
  return rows.map((r) => ({ ...r, role: normalizeRole(r.role) }));
}

/** Cambia el rol de un miembro (Propietario ↔ Vendedor). */
export async function changeRole(
  organizationId: string,
  actorUserId: string,
  memberId: string,
  role: Role,
  deps: TeamDeps = defaultDeps
): Promise<TeamMember> {
  return deps.runInTx(async (store) => {
    // Primero los owners (orden de bloqueo fijo), luego el objetivo.
    const ownerIds = await store.lockOwnerIds(organizationId);
    const target = await store.findMember(organizationId, memberId);
    if (!target) throw notFound();
    if (target.userId === actorUserId) throw selfChange();
    if (target.role === role) return target;
    if (role !== ROLE.owner && wouldLeaveNoOwner(target, ownerIds)) {
      throw lastOwner();
    }
    await store.setRole(organizationId, memberId, role);
    return { ...target, role };
  });
}

/**
 * Da de baja a un miembro: borra la membresía y todas sus sesiones (su próxima
 * petición responde 401 y no puede volver a iniciar sesión) y avisa a
 * `onMemberRemoved`. La fila `user` se conserva (D-00-1).
 *
 * Devuelve los ids de las conversaciones que quedaron sin asignar (09); se
 * resuelve tras el commit, así que el llamador ya puede publicarlas.
 */
export async function removeMember(
  organizationId: string,
  actorUserId: string,
  memberId: string,
  deps: TeamDeps = defaultDeps
): Promise<string[]> {
  return deps.runInTx(async (store, tx) => {
    const ownerIds = await store.lockOwnerIds(organizationId);
    const target = await store.findMember(organizationId, memberId);
    if (!target) throw notFound();
    if (target.userId === actorUserId) throw selfChange();
    if (wouldLeaveNoOwner(target, ownerIds)) throw lastOwner();
    await store.deleteMember(organizationId, memberId);
    await store.deleteSessions(target.userId);
    return deps.onMemberRemoved(organizationId, target.userId, tx);
  });
}

/**
 * Restablece la contraseña de otro miembro: genera una temporal, guarda su
 * hash y revoca sus sesiones. Devuelve la temporal (se muestra UNA vez).
 */
export async function resetPassword(
  organizationId: string,
  actorUserId: string,
  memberId: string,
  deps: TeamDeps = defaultDeps
): Promise<string> {
  const temporaryPassword = deps.generatePassword();
  const hash = await deps.hashPassword(temporaryPassword);
  await deps.runInTx(async (store) => {
    const target = await store.findMember(organizationId, memberId);
    if (!target) throw notFound();
    if (target.userId === actorUserId) throw selfChange();
    await store.setPasswordHash(target.userId, hash);
    await store.deleteSessions(target.userId);
  });
  return temporaryPassword;
}

export type NewMemberInput = { name: string; email: string; password: string };

/**
 * Alta de cuenta de equipo como Vendedor (RF-00-11). Si el correo ya existe
 * como usuario SIN membresía en la org (dado de baja), lo re-vincula con la
 * contraseña dada en vez de responder 409. Si ya es miembro → 409 `duplicate`.
 */
export async function createOrRelinkMember(
  organizationId: string,
  input: NewMemberInput,
  deps: TeamDeps = defaultDeps
): Promise<{ memberId: string; userId: string; relinked: boolean }> {
  const hash = await deps.hashPassword(input.password);
  const relinked = await deps.runInTx(async (store) => {
    const existing = await store.findUserByEmail(input.email);
    if (!existing) return null;
    const memberId = await store.insertMember(
      organizationId,
      existing.id,
      ROLE.seller
    );
    if (!memberId) throw duplicate();
    await store.setPasswordHash(existing.id, hash);
    await store.updateUserName(existing.id, input.name);
    await store.deleteSessions(existing.id);
    return { memberId, userId: existing.id, relinked: true };
  });
  if (relinked) return relinked;

  let userId: string;
  try {
    userId = await deps.signUp(input);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "No se pudo crear la cuenta";
    if (/exist/i.test(message)) throw duplicate();
    throw new TeamError(422, "invalid", message);
  }

  return deps.runInTx(async (store) => {
    const memberId = await store.insertMember(organizationId, userId, ROLE.seller);
    if (!memberId) throw duplicate();
    // signUpEmail deja una sesión server-side que nadie usa: fuera.
    await store.deleteSessions(userId);
    return { memberId, userId, relinked: false };
  });
}

function duplicate(): TeamError {
  return new TeamError(409, "duplicate", "Ya existe una cuenta con ese correo");
}
