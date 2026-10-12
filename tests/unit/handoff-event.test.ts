import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 05/02-0 — `markHandoff`, la puerta única de escalamiento: UPDATE condicional
 * (`handoff_at IS NULL`) + evento `opened` en la misma transacción + SSE tras
 * el commit. El Laboratorio solo recibe el UPDATE.
 */

const publish = vi.fn();
vi.mock("@/server/events/bus", () => ({ publish }));

// BD simulada: el RETURNING del UPDATE lo decide cada prueba.
let returningRows: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
const whereArgs: unknown[] = [];
let transactions = 0;
let txOpen = false;
const publishedInsideTx: unknown[] = [];

vi.mock("@/lib/db", () => {
  const fakeDb = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, ...values });
        return {
          where: (cond: unknown) => {
            whereArgs.push(cond);
            return { returning: () => Promise.resolve(returningRows) };
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return Promise.resolve([values]);
      },
    }),
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      transactions += 1;
      txOpen = true;
      try {
        return await fn(fakeDb);
      } finally {
        txOpen = false;
      }
    },
  };
  return {
    getDb: () => fakeDb,
    schema: new Proxy(
      {},
      {
        get: (_t, tableName) =>
          new Proxy(
            { __table: String(tableName) },
            {
              get: (t, col) =>
                col === "__table" ? t.__table : `${String(tableName)}.${String(col)}`,
            }
          ),
      }
    ),
  };
});

// `scoped` real necesita columnas reales: aquí solo importa que se llame.
vi.mock("@/lib/db/tenant", () => ({
  scoped: (_col: unknown, orgId: string, ...rest: unknown[]) => ({ orgId, rest }),
}));

const base = {
  organizationId: "org_1",
  conversationId: "cv_1",
  reason: "cliente" as const,
  note: "  pidió hablar con alguien  ",
  source: "agente" as const,
  pauseAi: false,
};

describe("markHandoff", () => {
  beforeEach(() => {
    returningRows = [];
    updates.length = 0;
    inserts.length = 0;
    whereArgs.length = 0;
    publishedInsideTx.length = 0;
    transactions = 0;
    publish.mockReset();
    publish.mockImplementation((...args: unknown[]) => {
      if (txOpen) publishedInsideTx.push(args);
    });
  });

  it("transición: UPDATE + evento opened en la transacción + 2 publicaciones tras el commit", async () => {
    returningRows = [{ id: "cv_1", isTest: false }];
    const { markHandoff } = await import("@/server/inbox/handoff");
    const r = await markHandoff({ ...base, actorUserId: "usr_1" });

    expect(r.applied).toBe(true);
    expect(transactions).toBe(1);
    expect(updates).toHaveLength(1);
    const set = updates[0]!;
    expect(set.handoffAt).toBeInstanceOf(Date);
    expect(set.handoffReason).toBe("cliente");
    expect(set.handoffNote).toBe("pidió hablar con alguien");
    expect("aiEnabled" in set).toBe(false);

    expect(inserts).toHaveLength(1);
    const ev = inserts[0]!.values;
    expect(ev).toMatchObject({
      organizationId: "org_1",
      conversationId: "cv_1",
      kind: "opened",
      reason: "cliente",
      note: "pidió hablar con alguien",
      source: "agente",
      actorUserId: "usr_1",
      approximate: false,
    });
    expect(String(ev.id)).toMatch(/^hoe_/);
    // La hora del evento ES la del handoff (una sola marca de tiempo).
    expect(ev.createdAt).toBe(set.handoffAt);

    expect(publishedInsideTx).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, "org_1", {
      type: "conversation.handoff",
      data: {
        conversationId: "cv_1",
        reason: "cliente",
        handoffAt: (set.handoffAt as Date).toISOString(),
      },
    });
    expect(publish).toHaveBeenNthCalledWith(2, "org_1", {
      type: "conversation.updated",
      data: { conversation: { id: "cv_1" } },
    });
  });

  it("el UPDATE es condicional: exige handoff_at IS NULL y el tenant", async () => {
    returningRows = [{ id: "cv_1", isTest: false }];
    const { markHandoff } = await import("@/server/inbox/handoff");
    await markHandoff(base);
    const cond = whereArgs[0] as { orgId: string; rest: unknown[] };
    expect(cond.orgId).toBe("org_1");
    // id + IS NULL
    expect(cond.rest).toHaveLength(2);
  });

  it("con handoff ya abierto (RETURNING vacío) no inserta ni publica", async () => {
    returningRows = [];
    const { markHandoff } = await import("@/server/inbox/handoff");
    const r = await markHandoff(base);
    expect(r).toEqual({ applied: false });
    expect(inserts).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("segunda llamada sobre la misma conversación (ventana → modelo) no escribe evento ni publica", async () => {
    const { markHandoff } = await import("@/server/inbox/handoff");
    returningRows = [{ id: "cv_1", isTest: false }];
    await markHandoff({ ...base, reason: "ventana" });
    returningRows = []; // la BD ya tiene handoff_at
    await markHandoff({ ...base, reason: "modelo" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.reason).toBe("ventana");
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("is_test: solo el UPDATE — cero filas de bitácora y cero eventos SSE", async () => {
    returningRows = [{ id: "cv_lab", isTest: true }];
    const { markHandoff } = await import("@/server/inbox/handoff");
    const r = await markHandoff({ ...base, conversationId: "cv_lab" });
    expect(r).toMatchObject({ applied: true, isTest: true });
    expect(updates).toHaveLength(1);
    expect(inserts).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("pauseAi: true apaga la IA; false no toca ai_enabled", async () => {
    returningRows = [{ id: "cv_1", isTest: false }];
    const { markHandoff } = await import("@/server/inbox/handoff");
    await markHandoff({
      ...base,
      reason: "manual_reply",
      note: null,
      source: "telefono",
      pauseAi: true,
    });
    expect(updates[0]!.aiEnabled).toBe(false);
    expect(updates[0]!.handoffNote).toBeNull();
    expect(inserts[0]!.values).toMatchObject({
      reason: "manual_reply",
      source: "telefono",
      note: null,
      actorUserId: null,
    });
  });
});
