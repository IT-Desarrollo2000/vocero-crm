import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChannelProfileName } from "@/server/channels/profile";

/**
 * 022 — El nombre que se consulta a Graph (Instagram/Messenger) se guarda
 * también como `profile_name`, sin llamadas extra: solo se pide si el
 * contacto es nuevo o sigue con el respaldo.
 */

const dbState = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const select: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit"]) select[m] = () => select;
  (select as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve(dbState.selectRows);
  const db = {
    select: () => select,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        dbState.updates.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  return { ...actual, getDb: () => db };
});

const base = {
  organizationId: "org_1",
  channel: "messenger" as const,
  identity: "fb:123",
};

beforeEach(() => {
  dbState.selectRows = [];
  dbState.updates = [];
});

describe("resolveChannelProfileName", () => {
  it("contacto con respaldo: guarda nombre Y profile_name", async () => {
    dbState.selectRows = [{ id: "ct_1", name: "Contacto de Messenger" }];
    const name = await resolveChannelProfileName({
      ...base,
      fetchName: async () => "  Dios es amor ",
    });
    expect(name).toBe("Dios es amor");
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      name: "Dios es amor",
      profileName: "Dios es amor",
    });
  });

  it("contacto nuevo: devuelve el nombre (el alta guarda profile_name)", async () => {
    const name = await resolveChannelProfileName({
      ...base,
      fetchName: async () => "Ana",
    });
    expect(name).toBe("Ana");
    expect(dbState.updates).toHaveLength(0);
  });

  it("contacto ya nombrado: ni consulta a Graph ni escribe", async () => {
    dbState.selectRows = [{ id: "ct_1", name: "Lucía Ramírez" }];
    const fetchName = vi.fn(async () => "Otro");
    const name = await resolveChannelProfileName({ ...base, fetchName });
    expect(name).toBeNull();
    expect(fetchName).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it("Graph falla: deja el respaldo sin escribir", async () => {
    dbState.selectRows = [{ id: "ct_1", name: "Contacto de Messenger" }];
    const name = await resolveChannelProfileName({
      ...base,
      fetchName: async () => {
        throw new Error("graph caído");
      },
    });
    expect(name).toBeNull();
    expect(dbState.updates).toHaveLength(0);
  });
});
