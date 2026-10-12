import { describe, expect, it, vi } from "vitest";
import {
  isBlockedAuthPath,
  REMOVED_ACCOUNT_MESSAGE,
  shouldAllowSessionCreation,
} from "@/server/auth/policy";

/**
 * Tarea 00 — superficie de Better Auth.
 * RF-00-10: el árbol `/organization/*` del plugin queda bloqueado (404) para
 * todos; el resto de endpoints que usa Vocero sigue abierto.
 * RF-00-13: una cuenta sin membresía (dada de baja) no inicia sesión, sin
 * romper el primer registro ni el alta de equipo.
 */

describe("bloqueo de /organization/* (RF-00-10)", () => {
  it.each([
    "/organization/create",
    "/organization/update-member-role",
    "/organization/delete",
    "/organization/remove-member",
    "/organization/invite-member",
    "/organization/set-active",
    "/organization/leave",
    "/organization",
  ])("rechaza %s", (path) => {
    expect(isBlockedAuthPath(path)).toBe(true);
  });

  it.each([
    "/sign-in/email",
    "/sign-up/email",
    "/change-password",
    "/update-user",
    "/get-session",
    "/sign-out",
    "/organizations-like", // sin la barra no es el árbol del plugin
    "",
  ])("deja pasar %s", (path) => {
    expect(isBlockedAuthPath(path)).toBe(false);
  });

  it("path ausente no bloquea (no es un endpoint)", () => {
    expect(isBlockedAuthPath(undefined)).toBe(false);
    expect(isBlockedAuthPath(null)).toBe(false);
  });
});

describe("bloqueo de inicio de sesión sin membresía (RF-00-13)", () => {
  const base = {
    hasMembership: false,
    path: "/sign-in/email",
    internalSignup: false,
  };

  it("cuenta dada de baja (sin membresía, con org existente) → bloquea", async () => {
    const organizationExists = vi.fn(async () => true);
    expect(
      await shouldAllowSessionCreation({ ...base, organizationExists })
    ).toBe(false);
  });

  it("con membresía → permite sin consultar organizaciones", async () => {
    const organizationExists = vi.fn(async () => true);
    expect(
      await shouldAllowSessionCreation({
        ...base,
        hasMembership: true,
        organizationExists,
      })
    ).toBe(true);
    expect(organizationExists).not.toHaveBeenCalled();
  });

  it("primer registro: la org aún no existe al crear la sesión → permite", async () => {
    // En 1.6.x el user.create.after se encola hasta el commit del sign-up:
    // cuando nace la sesión, la org + membresía owner todavía no existen.
    expect(
      await shouldAllowSessionCreation({
        ...base,
        path: "/sign-up/email",
        organizationExists: async () => false,
      })
    ).toBe(true);
    expect(
      await shouldAllowSessionCreation({
        ...base,
        path: null,
        organizationExists: async () => false,
      })
    ).toBe(true);
  });

  it("alta de equipo (sign-up con org existente, membresía aún no creada) → permite", async () => {
    const organizationExists = vi.fn(async () => true);
    expect(
      await shouldAllowSessionCreation({
        ...base,
        path: "/sign-up/email",
        organizationExists,
      })
    ).toBe(true);
    expect(organizationExists).not.toHaveBeenCalled();
  });

  it("dentro de runInternalSignup aunque no llegue el path → permite", async () => {
    expect(
      await shouldAllowSessionCreation({
        ...base,
        path: undefined,
        internalSignup: true,
        organizationExists: async () => true,
      })
    ).toBe(true);
  });

  it("sin contexto de endpoint (path null) y org existente → bloquea", async () => {
    expect(
      await shouldAllowSessionCreation({
        ...base,
        path: null,
        organizationExists: async () => true,
      })
    ).toBe(false);
  });

  it("el mensaje dice que el acceso fue dado de baja", () => {
    expect(REMOVED_ACCOUNT_MESSAGE).toMatch(/dado de baja/);
  });
});
