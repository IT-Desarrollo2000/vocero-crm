import { beforeEach, describe, expect, it, vi } from "vitest";

// members.ts importa la auth y la BD reales; aquí todo pasa por TeamDeps.
vi.mock("@/lib/auth", () => ({
  getAuth: () => {
    throw new Error("getAuth no debe llamarse en unit");
  },
  runInternalSignup: () => {
    throw new Error("runInternalSignup no debe llamarse en unit");
  },
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("getDb no debe llamarse en unit");
  },
  schema: {},
}));

import {
  changeRole,
  createOrRelinkMember,
  generateTemporaryPassword,
  removeMember,
  resetPassword,
  TeamError,
  type DbTx,
  type TeamDeps,
  type TeamMember,
  type TeamStore,
} from "@/server/team/members";
import type { Role } from "@/lib/roles";

/**
 * Tarea 00 — gestión de equipo (RF-00-11/12): las guardas se prueban contra
 * un store en memoria. La concurrencia real (FOR UPDATE) la cubre el E2E
 * contra Postgres.
 */

const ORG = "org_1";

type FakeUser = { id: string; name: string; email: string; password: string };

function setup() {
  const members: TeamMember[] = [];
  const users: FakeUser[] = [];
  const sessions = new Map<string, number>(); // userId → nº de sesiones
  const calls: string[] = [];
  let seq = 0;

  function addMember(userId: string, role: Role, name = userId): TeamMember {
    if (!users.some((u) => u.id === userId)) {
      users.push({ id: userId, name, email: `${userId}@x.test`, password: "old" });
    }
    const m: TeamMember = {
      id: `mem_${++seq}`,
      userId,
      role,
      name,
      email: `${userId}@x.test`,
      createdAt: new Date(2026, 0, seq),
    };
    members.push(m);
    sessions.set(userId, 2);
    return m;
  }

  const store: TeamStore = {
    async lockOwnerIds() {
      calls.push("lockOwnerIds");
      return members.filter((m) => m.role === "owner").map((m) => m.id);
    },
    async findMember(_org, memberId) {
      return members.find((m) => m.id === memberId) ?? null;
    },
    async setRole(_org, memberId, role) {
      const m = members.find((x) => x.id === memberId);
      if (m) m.role = role;
    },
    async deleteMember(_org, memberId) {
      const i = members.findIndex((m) => m.id === memberId);
      if (i >= 0) members.splice(i, 1);
      calls.push(`deleteMember:${memberId}`);
    },
    async deleteSessions(userId) {
      sessions.set(userId, 0);
      calls.push(`deleteSessions:${userId}`);
    },
    async setPasswordHash(userId, hash) {
      const u = users.find((x) => x.id === userId);
      if (u) u.password = hash;
    },
    async findUserByEmail(email) {
      const u = users.find((x) => x.email.toLowerCase() === email.toLowerCase());
      return u ? { id: u.id, name: u.name } : null;
    },
    async insertMember(_org, userId, role) {
      if (members.some((m) => m.userId === userId)) return null;
      return addMember(userId, role).id;
    },
    async updateUserName(userId, name) {
      const u = users.find((x) => x.id === userId);
      if (u) u.name = name;
    },
  };

  const fakeTx = { fake: "tx" } as unknown as DbTx;
  const onMemberRemoved = vi.fn(async () => {});
  const signUp = vi.fn(async (input: { name: string; email: string; password: string }) => {
    const id = `usr_${++seq}`;
    users.push({ id, ...input, password: `hash(${input.password})` });
    sessions.set(id, 1);
    return id;
  });
  const deps: TeamDeps = {
    runInTx: (fn) => fn(store, fakeTx),
    hashPassword: async (p) => `hash(${p})`,
    generatePassword: () => "TempPass23456789",
    signUp,
    onMemberRemoved,
  };

  return { members, users, sessions, calls, addMember, deps, fakeTx, onMemberRemoved, signUp };
}

async function expectTeamError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TeamError);
  expect((err as TeamError).status).toBe(status);
  expect((err as TeamError).code).toBe(code);
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("changeRole", () => {
  it("el Propietario no puede cambiar su propio rol (409 self_change)", async () => {
    const owner = t.addMember("ana", "owner");
    await expectTeamError(changeRole(ORG, "ana", owner.id, "member", t.deps), 409, "self_change");
    expect(owner.role).toBe("owner");
  });

  it("no se puede degradar al último Propietario (409 last_owner)", async () => {
    t.addMember("ana", "owner");
    const other = t.addMember("beto", "owner");
    // Ana degrada a Beto: quedan dos owners → OK.
    await changeRole(ORG, "ana", other.id, "member", t.deps);
    expect(other.role).toBe("member");

    // Escenario con un único owner que no es el actor (p. ej. otro owner ya
    // degradado en paralelo): degradarlo dejaría 0.
    const t2 = setup();
    const solo = t2.addMember("carla", "owner");
    t2.addMember("dani", "member");
    await expectTeamError(
      changeRole(ORG, "dani", solo.id, "member", t2.deps),
      409,
      "last_owner"
    );
    expect(solo.role).toBe("owner");
  });

  it("promueve a un Vendedor y bloquea primero a los owners", async () => {
    t.addMember("ana", "owner");
    const seller = t.addMember("beto", "member");
    const updated = await changeRole(ORG, "ana", seller.id, "owner", t.deps);
    expect(updated).toMatchObject({ id: seller.id, userId: "beto", role: "owner" });
    expect(t.calls[0]).toBe("lockOwnerIds");
  });

  it("mismo rol → no-op sin error", async () => {
    t.addMember("ana", "owner");
    const seller = t.addMember("beto", "member");
    expect((await changeRole(ORG, "ana", seller.id, "member", t.deps)).role).toBe("member");
  });

  it("miembro inexistente → 404", async () => {
    t.addMember("ana", "owner");
    await expectTeamError(changeRole(ORG, "ana", "mem_nada", "owner", t.deps), 404, "not_found");
  });
});

describe("removeMember", () => {
  it("borra la membresía y TODAS las sesiones, y llama onMemberRemoved con la tx", async () => {
    t.addMember("ana", "owner");
    const seller = t.addMember("beto", "member");
    await removeMember(ORG, "ana", seller.id, t.deps);

    expect(t.members.some((m) => m.id === seller.id)).toBe(false);
    expect(t.sessions.get("beto")).toBe(0);
    expect(t.onMemberRemoved).toHaveBeenCalledWith(ORG, "beto", t.fakeTx);
    // La fila user se conserva (D-00-1).
    expect(t.users.some((u) => u.id === "beto")).toBe(true);
    // Las sesiones del actor no se tocan.
    expect(t.sessions.get("ana")).toBe(2);
  });

  it("nadie se da de baja a sí mismo (409 self_change)", async () => {
    const owner = t.addMember("ana", "owner");
    await expectTeamError(removeMember(ORG, "ana", owner.id, t.deps), 409, "self_change");
    expect(t.onMemberRemoved).not.toHaveBeenCalled();
  });

  it("no se da de baja al último Propietario (409 last_owner)", async () => {
    const solo = t.addMember("carla", "owner");
    t.addMember("dani", "member");
    await expectTeamError(removeMember(ORG, "dani", solo.id, t.deps), 409, "last_owner");
    expect(t.members.some((m) => m.id === solo.id)).toBe(true);
    expect(t.sessions.get("carla")).toBe(2);
    expect(t.onMemberRemoved).not.toHaveBeenCalled();
  });

  it("con dos Propietarios, uno puede dar de baja al otro", async () => {
    t.addMember("ana", "owner");
    const other = t.addMember("beto", "owner");
    await removeMember(ORG, "ana", other.id, t.deps);
    expect(t.members.map((m) => m.userId)).toEqual(["ana"]);
  });
});

describe("resetPassword", () => {
  it("fija el hash de la temporal, revoca sesiones y devuelve la temporal", async () => {
    t.addMember("ana", "owner");
    const seller = t.addMember("beto", "member");
    const temp = await resetPassword(ORG, "ana", seller.id, t.deps);
    expect(temp).toBe("TempPass23456789");
    expect(t.users.find((u) => u.id === "beto")?.password).toBe("hash(TempPass23456789)");
    expect(t.sessions.get("beto")).toBe(0);
  });

  it("no la propia (409 self_change)", async () => {
    const owner = t.addMember("ana", "owner");
    await expectTeamError(resetPassword(ORG, "ana", owner.id, t.deps), 409, "self_change");
  });

  it("la temporal por defecto es larga, sin ambiguos y distinta cada vez", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(16);
      expect(p).not.toMatch(/[0O1lI]/);
      expect(p).toMatch(/^[a-zA-Z2-9]+$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});

describe("createOrRelinkMember", () => {
  it("correo nuevo → alta vía signUp, membresía Vendedor y sin sesión residual", async () => {
    t.addMember("ana", "owner");
    const r = await createOrRelinkMember(
      ORG,
      { name: "Eva", email: "eva@x.test", password: "temporal-123" },
      t.deps
    );
    expect(r.relinked).toBe(false);
    expect(t.signUp).toHaveBeenCalledOnce();
    expect(t.members.find((m) => m.userId === r.userId)?.role).toBe("member");
    expect(t.sessions.get(r.userId)).toBe(0);
  });

  it("correo de una cuenta dada de baja → re-vincula con la contraseña dada", async () => {
    t.addMember("ana", "owner");
    const seller = t.addMember("beto", "member");
    await removeMember(ORG, "ana", seller.id, t.deps);

    const r = await createOrRelinkMember(
      ORG,
      { name: "Beto Nuevo", email: "BETO@x.test", password: "otra-temporal-1" },
      t.deps
    );
    expect(r).toMatchObject({ userId: "beto", relinked: true });
    expect(t.signUp).not.toHaveBeenCalled();
    const user = t.users.find((u) => u.id === "beto");
    expect(user?.password).toBe("hash(otra-temporal-1)");
    expect(user?.name).toBe("Beto Nuevo");
    expect(t.members.find((m) => m.userId === "beto")?.role).toBe("member");
  });

  it("correo que ya es miembro → 409 duplicate", async () => {
    t.addMember("ana", "owner");
    t.addMember("beto", "member");
    await expectTeamError(
      createOrRelinkMember(ORG, { name: "B", email: "beto@x.test", password: "x".repeat(8) }, t.deps),
      409,
      "duplicate"
    );
  });

  it("signUp que falla por 'exists' (carrera) → 409; otro fallo → 422", async () => {
    t.addMember("ana", "owner");
    t.signUp.mockRejectedValueOnce(new Error("User already exists"));
    await expectTeamError(
      createOrRelinkMember(ORG, { name: "Z", email: "z@x.test", password: "x".repeat(8) }, t.deps),
      409,
      "duplicate"
    );
    t.signUp.mockRejectedValueOnce(new Error("Password too short"));
    await expectTeamError(
      createOrRelinkMember(ORG, { name: "Z", email: "z@x.test", password: "x".repeat(8) }, t.deps),
      422,
      "invalid"
    );
  });
});
