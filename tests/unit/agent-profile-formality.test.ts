import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 025 — Perfil del agente → "Trato con el cliente: Tú / Usted". La API
 * acepta solo `tu` | `usted`, lo devuelve al Propietario y lo guarda.
 */

const sessionState: { current: SessionContext | null } = { current: null };
vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

const row = {
  enabled: true,
  name: "Vale",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
  formality: "usted",
};
const updates: Record<string, unknown>[] = [];
vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit"]) c[m] = () => c;
    (c as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      Promise.resolve(rows).then(resolve);
    return c;
  };
  return {
    getDb: () => ({
      select: () => chain([row]),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: () => ({ returning: async () => [{ id: "agp_1" }] }) };
        },
      }),
    }),
    schema: new Proxy(
      {},
      {
        get: (_t, table) =>
          new Proxy({}, { get: (_t2, col) => `${String(table)}.${String(col)}` }),
      }
    ),
  };
});

const { GET, PUT } = await import("@/app/api/agent/profile/route");

const OWNER: SessionContext = { userId: "u_o", organizationId: "org_1", role: "owner" };
const put = (body: unknown) =>
  PUT(
    new Request("http://x/api/agent/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  sessionState.current = OWNER;
  updates.length = 0;
});

describe("/api/agent/profile — formality", () => {
  it("GET devuelve el trato al Propietario", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ formality: "usted" });
  });

  it("PUT acepta tu y usted y lo guarda", async () => {
    for (const formality of ["tu", "usted"]) {
      const res = await put({ formality });
      expect(res.status).toBe(200);
    }
    expect(updates.map((u) => u.formality)).toEqual(["tu", "usted"]);
  });

  it("PUT rechaza otro valor (422) sin escribir", async () => {
    for (const formality of ["vos", "Usted", "", 1, null]) {
      const res = await put({ formality });
      expect(res.status).toBe(422);
    }
    expect(updates).toEqual([]);
  });
});
