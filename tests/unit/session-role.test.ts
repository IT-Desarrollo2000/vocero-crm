import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireSession` normaliza el rol de la membresía (dev-tasks/00, RF-00-01)
 * y `requireOwnerPage` protege páginas server: sin sesión → /login,
 * Vendedor → 404, Propietario → devuelve la sesión.
 */

const state: {
  user: { id: string } | null;
  membership: { organizationId: string; role: string } | null;
} = { user: null, membership: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => (state.user ? { user: state.user } : null),
    },
  }),
}));
vi.mock("@/server/auth/on-signup", () => ({
  resolveMembership: async () => state.membership,
}));

class NextSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new NextSignal(`redirect:${url}`);
  },
  notFound: () => {
    throw new NextSignal("notFound");
  },
}));

const { requireSession, getSessionOrNull } = await import("@/lib/auth/session");
const { requireOwnerPage } = await import("@/lib/auth/guards");

beforeEach(() => {
  state.user = { id: "u_1" };
  state.membership = null;
});

describe("requireSession normaliza el rol", () => {
  it.each([
    ["owner", "owner"],
    ["member", "member"],
    ["admin", "member"],
    ["OWNER", "member"],
    ["", "member"],
  ])("BD %j → %s", async (raw, expected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.membership = { organizationId: "org_1", role: raw };
    const s = await requireSession();
    expect(s).toEqual({ userId: "u_1", organizationId: "org_1", role: expected });
    warn.mockRestore();
  });

  it("getSessionOrNull también normaliza", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.membership = { organizationId: "org_1", role: "admin" };
    expect((await getSessionOrNull())?.role).toBe("member");
    warn.mockRestore();
  });
});

describe("requireOwnerPage", () => {
  it("sin sesión → redirect a /login", async () => {
    state.user = null;
    await expect(requireOwnerPage()).rejects.toThrow("redirect:/login");
  });

  it("sin membresía → redirect a /login", async () => {
    await expect(requireOwnerPage()).rejects.toThrow("redirect:/login");
  });

  it("Vendedor → notFound", async () => {
    state.membership = { organizationId: "org_1", role: "member" };
    await expect(requireOwnerPage()).rejects.toThrow("notFound");
  });

  it("Propietario → devuelve la sesión", async () => {
    state.membership = { organizationId: "org_1", role: "owner" };
    await expect(requireOwnerPage()).resolves.toEqual({
      userId: "u_1",
      organizationId: "org_1",
      role: "owner",
    });
  });
});
