import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Eliminar una evaluación del Laboratorio: una corrida en curso NO se borra
 * (protege el candado UNIQUE parcial), y una terminada se lleva sus
 * conversaciones y citas de prueba — nunca los contactos sintéticos.
 */

// BD simulada: cola de resultados de select + registro de deletes en orden.
const selectQueue: unknown[][] = [];
const deletes: string[] = [];
let runDeleteRows: unknown[] = [{ id: "tr_1" }];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

const tx = {
  select: () => thenableChain(selectQueue.shift() ?? []),
  delete: (table: { __name: string }) => ({
    where: () => {
      deletes.push(table.__name);
      const rows = table.__name === "agentTestRun" ? runDeleteRows : [];
      return {
        returning: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve(rows).then(resolve),
      };
    },
  }),
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__name"
                ? String(tableName)
                : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

vi.mock("drizzle-orm", () => {
  const sql = (...args: unknown[]) => ({ args });
  return {
    and: sql,
    eq: sql,
    inArray: sql,
    isNotNull: sql,
    ne: sql,
  };
});

describe("deleteTestRun", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    deletes.length = 0;
    runDeleteRows = [{ id: "tr_1" }];
  });

  it("corrida inexistente o de otra org → not_found sin borrar nada", async () => {
    selectQueue.push([]);
    const { deleteTestRun } = await import("@/server/lab/delete");
    expect(await deleteTestRun("org_1", "tr_x")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(deletes).toEqual([]);
  });

  it("corrida en curso → run_in_progress sin borrar nada", async () => {
    selectQueue.push([{ id: "tr_1", status: "running" }]);
    const { deleteTestRun } = await import("@/server/lab/delete");
    expect(await deleteTestRun("org_1", "tr_1")).toEqual({
      ok: false,
      reason: "run_in_progress",
    });
    expect(deletes).toEqual([]);
  });

  it("corrida terminada → borra run, citas y conversaciones de prueba (no contactos)", async () => {
    selectQueue.push(
      [{ id: "tr_1", status: "done" }],
      [{ conversationId: "cv_1" }, { conversationId: "cv_2" }]
    );
    const { deleteTestRun } = await import("@/server/lab/delete");
    expect(await deleteTestRun("org_1", "tr_1")).toEqual({ ok: true });
    expect(deletes).toEqual(["agentTestRun", "booking", "conversation"]);
    expect(deletes).not.toContain("contact");
  });

  it("corrida fallida sin conversaciones → solo borra el run", async () => {
    selectQueue.push([{ id: "tr_1", status: "failed" }], []);
    const { deleteTestRun } = await import("@/server/lab/delete");
    expect(await deleteTestRun("org_1", "tr_1")).toEqual({ ok: true });
    expect(deletes).toEqual(["agentTestRun"]);
  });

  it("carrera: el run desapareció entre el SELECT y el DELETE → not_found", async () => {
    selectQueue.push([{ id: "tr_1", status: "done" }], [{ conversationId: "cv_1" }]);
    runDeleteRows = [];
    const { deleteTestRun } = await import("@/server/lab/delete");
    expect(await deleteTestRun("org_1", "tr_1")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(deletes).toEqual(["agentTestRun"]);
  });
});
