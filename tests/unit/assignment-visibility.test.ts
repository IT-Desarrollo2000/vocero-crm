import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  canSeeConversation,
  conversationVisibleTo,
} from "@/server/inbox/visibility";
import { onMemberRemoved, type DbTx } from "@/server/team/members";

/**
 * Tarea 09 (contrato 09-0): el predicado de visibilidad de la Bandeja y el
 * hook de baja. El comportamiento contra Postgres lo ejercita el E2E de
 * asignación (T-09-15).
 */

const dialect = new PgDialect();
const render = (condition: SQL) => dialect.sqlToQuery(condition);

const owner = { userId: "usr_owner", role: "owner" as const };
const seller = { userId: "usr_a", role: "member" as const };

describe("conversationVisibleTo", () => {
  it("Propietario → `true` (sin filtro, pero siempre SQL)", () => {
    const q = render(conversationVisibleTo(owner));
    expect(q.sql.trim()).toBe("true");
    expect(q.params).toEqual([]);
  });

  it("Vendedor → assigned_user_id = yo OR assigned_user_id IS NULL", () => {
    const q = render(conversationVisibleTo(seller));
    expect(q.sql).toMatch(/"assigned_user_id" = \$1 or "conversation"\."assigned_user_id" is null/);
    expect(q.params).toEqual(["usr_a"]);
  });

  it("dentro de scoped(): org AND id AND (visible) — vale para SELECT y UPDATE", () => {
    const q = render(
      scoped(
        schema.conversation.organizationId,
        "org_1",
        eq(schema.conversation.id, "cv_1"),
        conversationVisibleTo(seller)
      )
    );
    expect(q.sql).toContain('"organization_id" = $1');
    expect(q.sql).toContain('"id" = $2');
    // El OR va entre paréntesis: no se "escapa" del AND del tenant.
    expect(q.sql).toMatch(/and \(.*"assigned_user_id" = \$3 or .*is null\)/);
    expect(q.params).toEqual(["org_1", "cv_1", "usr_a"]);
  });
});

describe("canSeeConversation", () => {
  it("Propietario → true sin tocar la BD", async () => {
    // Sin DATABASE_URL, cualquier consulta lanzaría.
    await expect(canSeeConversation("org_1", owner, "cv_x")).resolves.toBe(true);
  });
});

describe("onMemberRemoved (baja → sin asignar)", () => {
  it("UPDATE dentro de la tx: assigned_user_id/assigned_at a NULL, por org + usuario, devuelve ids", async () => {
    const calls: { set?: Record<string, unknown>; where?: SQL } = {};
    const tx = {
      update: (table: unknown) => {
        expect(table).toBe(schema.conversation);
        return {
          set: (values: Record<string, unknown>) => {
            calls.set = values;
            return {
              where: (where: SQL) => {
                calls.where = where;
                return {
                  returning: async () => [{ id: "cv_1" }, { id: "cv_2" }],
                };
              },
            };
          },
        };
      },
    } as unknown as DbTx;

    const ids = await onMemberRemoved("org_1", "usr_b", tx);

    expect(ids).toEqual(["cv_1", "cv_2"]);
    expect(calls.set).toMatchObject({ assignedUserId: null, assignedAt: null });
    const q = render(calls.where!);
    expect(q.sql).toContain('"organization_id" = $1');
    expect(q.sql).toContain('"assigned_user_id" = $2');
    expect(q.params).toEqual(["org_1", "usr_b"]);
  });
});
