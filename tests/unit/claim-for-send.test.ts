import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * 09 (RF-09-07, T-09-05): "responder = tomar". `claimForSend` es UN UPDATE
 * condicional (sin asignar o ya mío) con RETURNING; `gateSend` es la
 * compuerta de las rutas de envío: el Propietario pasa sin tocar la BD
 * (D-09-3) y el Vendedor solo envía si reclamó.
 *
 * Sin Postgres: la BD se simula con un único registro y el WHERE se evalúa
 * de forma atómica por sentencia, como lo hace Postgres con el bloqueo de
 * fila. La carrera real la ejercita `scripts/e2e-asignacion.mjs`.
 */

const state = { assigned: null as string | null, updates: 0 };

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...original,
    getDb: () => ({
      update: () => ({
        set: (values: { assignedUserId: string }) => ({
          where: () => ({
            returning: async () => {
              state.updates++;
              // Una sentencia = una evaluación atómica del WHERE.
              await Promise.resolve();
              const me = values.assignedUserId;
              if (state.assigned === null || state.assigned === me) {
                state.assigned = me;
                return [{ id: "cv_1" }];
              }
              return [];
            },
          }),
        }),
      }),
    }),
  };
});

const published: unknown[] = [];
vi.mock("@/server/events/bus", () => ({
  publish: (_org: string, event: unknown) => published.push(event),
}));

const { claimCondition, claimForSend, gateSend } = await import(
  "@/server/inbox/queries"
);

beforeEach(() => {
  state.assigned = null;
  state.updates = 0;
  published.length = 0;
});

describe("claimCondition — forma del WHERE", () => {
  it("org AND id AND is_test = false AND (sin asignar OR mía)", () => {
    const q = new PgDialect().sqlToQuery(claimCondition("org_1", "cv_1", "usr_a"));
    expect(q.sql).toContain('"organization_id" = $1');
    expect(q.sql).toContain('"id" = $2');
    expect(q.sql).toContain('"is_test" = $3');
    expect(q.sql).toMatch(/\("conversation"\."assigned_user_id" is null or "conversation"\."assigned_user_id" = \$4\)/);
    expect(q.params).toEqual(["org_1", "cv_1", false, "usr_a"]);
  });
});

describe("claimForSend / gateSend", () => {
  it("dos vendedores a la vez sobre una sin asignar → exactamente uno reclama", async () => {
    const [a, b] = await Promise.all([
      claimForSend("org_1", "cv_1", "usr_a"),
      claimForSend("org_1", "cv_1", "usr_b"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(state.assigned).toBe(a ? "usr_a" : "usr_b");
  });

  it("idempotente: reclamar la propia otra vez → true", async () => {
    expect(await claimForSend("org_1", "cv_1", "usr_a")).toBe(true);
    expect(await claimForSend("org_1", "cv_1", "usr_a")).toBe(true);
    expect(state.assigned).toBe("usr_a");
  });

  it("el que pierde la compuerta no envía (spy del sender)", async () => {
    state.assigned = "usr_a";
    const send = vi.fn();
    const session = { organizationId: "org_1", userId: "usr_b", role: "member" as const };
    if (await gateSend(session, "cv_1", null)) send();
    expect(send).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("el Propietario pasa sin tocar la BD ni asignarse (D-09-3)", async () => {
    const session = { organizationId: "org_1", userId: "usr_owner", role: "owner" as const };
    expect(await gateSend(session, "cv_1", null)).toBe(true);
    expect(state.updates).toBe(0);
    expect(state.assigned).toBeNull();
  });

  it("el Vendedor que toma una sin asignar avisa por SSE solo con el id", async () => {
    const session = { organizationId: "org_1", userId: "usr_a", role: "member" as const };
    expect(await gateSend(session, "cv_1", null)).toBe(true);
    expect(published).toEqual([
      { type: "conversation.updated", data: { conversation: { id: "cv_1" } } },
    ]);
    // Ya era suya: sin evento.
    expect(await gateSend(session, "cv_1", "usr_a")).toBe(true);
    expect(published).toHaveLength(1);
  });
});
