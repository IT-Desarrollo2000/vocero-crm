import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * Guarda de rol de `withAuth` (dev-tasks/00, RF-00-02): un Vendedor recibe
 * 403 `forbidden` sin que el handler llegue a ejecutarse; sin opciones el
 * comportamiento es el de siempre (cualquier rol pasa, 401 sin sesión).
 */

const sessionState: { current: SessionContext | null } = { current: null };

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor(message = "No autenticado") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

const { withAuth, requireOwner } = await import("@/lib/api");

const OWNER: SessionContext = {
  userId: "u_owner",
  organizationId: "org_1",
  role: "owner",
};
const SELLER: SessionContext = {
  userId: "u_seller",
  organizationId: "org_1",
  role: "member",
};

const handler = vi.fn(async () => Response.json({ ok: true }));

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

beforeEach(() => {
  handler.mockClear();
  sessionState.current = null;
});

describe("withAuth con { role: 'owner' }", () => {
  const guarded = withAuth(handler, { role: "owner" });

  it("Vendedor → 403 forbidden y el handler NO se llama", async () => {
    sessionState.current = SELLER;
    const res = await guarded();
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
    expect(handler).not.toHaveBeenCalled();
  });

  it("Propietario → 200 y el handler recibe la sesión", async () => {
    sessionState.current = OWNER;
    const res = await guarded();
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(OWNER);
  });

  it("sin sesión → 401 (antes que el 403)", async () => {
    const res = await guarded();
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
    expect(handler).not.toHaveBeenCalled();
  });

  it("un error del handler sigue siendo 500", async () => {
    sessionState.current = OWNER;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withAuth(
      async () => {
        throw new Error("boom");
      },
      { role: "owner" }
    )();
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});

describe("withAuth sin opciones (comportamiento actual)", () => {
  const open = withAuth(handler);

  it("Vendedor pasa", async () => {
    sessionState.current = SELLER;
    expect((await open()).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Propietario pasa", async () => {
    sessionState.current = OWNER;
    expect((await open()).status).toBe(200);
  });

  it("sin sesión → 401", async () => {
    expect((await open()).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("{ role: 'member' } no restringe a nadie", async () => {
    sessionState.current = SELLER;
    expect((await withAuth(handler, { role: "member" })()).status).toBe(200);
  });

  it("pasa los argumentos del route handler", async () => {
    sessionState.current = SELLER;
    const h = vi.fn(async (_s: SessionContext, req: Request) =>
      Response.json({ url: req.url })
    );
    const req = new Request("http://x/api/y");
    await withAuth(h)(req);
    expect(h).toHaveBeenCalledWith(SELLER, req);
  });
});

describe("requireOwner (chequeo dentro del handler)", () => {
  it("Propietario → null", () => {
    expect(requireOwner(OWNER)).toBeNull();
  });

  it("Vendedor → Response 403 forbidden", async () => {
    const res = requireOwner(SELLER);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(await errorCode(res as Response)).toBe("forbidden");
  });
});
