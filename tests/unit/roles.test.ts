import { describe, expect, it, vi } from "vitest";
import {
  isOwner,
  normalizeRole,
  ROLE,
  ROLE_LABELS,
  roleLabel,
} from "@/lib/roles";

/**
 * Roles (dev-tasks/00, RF-00-01): solo el literal exacto "owner" es
 * Propietario; cualquier otro valor se degrada a Vendedor y nunca escala.
 */

describe("normalizeRole", () => {
  it("'owner' → owner", () => {
    expect(normalizeRole("owner")).toBe("owner");
  });

  it("'member' → member sin avisar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeRole("member")).toBe("member");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(["admin", "", "OWNER", " owner", "Owner", null, undefined, 1, {}])(
    "%j → member (nunca escala)",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(normalizeRole(raw)).toBe("member");
      warn.mockRestore();
    }
  );

  it("avisa una sola vez por valor desconocido", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    normalizeRole("superadmin-unico");
    normalizeRole("superadmin-unico");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("isOwner", () => {
  it("acepta el rol o un objeto con role", () => {
    expect(isOwner("owner")).toBe(true);
    expect(isOwner("member")).toBe(false);
    expect(isOwner({ role: "owner" })).toBe(true);
    expect(isOwner({ role: "member" })).toBe(false);
  });
});

describe("etiquetas", () => {
  it("Propietario / Vendedor", () => {
    expect(ROLE_LABELS).toEqual({ owner: "Propietario", member: "Vendedor" });
    expect(roleLabel("owner")).toBe("Propietario");
    expect(roleLabel("member")).toBe("Vendedor");
  });

  it("ROLE.seller se guarda como 'member' en BD", () => {
    expect(ROLE.seller).toBe("member");
    expect(ROLE.owner).toBe("owner");
  });
});
