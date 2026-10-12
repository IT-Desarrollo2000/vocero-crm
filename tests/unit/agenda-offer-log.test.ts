import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 10 — `agenda_offer_log` (RF-10-14): una fila por ronda DESPUÉS de la
 * transacción de `replaceOffers`; si el registro falla, la oferta sigue en
 * pie; una ronda vacía no se registra.
 */

const logInserts: Record<string, unknown>[] = [];
let failLog = false;
let txCommitted = 0;

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit"]) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => Promise.resolve(rows).then(res);
  return c;
}

const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<void>) => {
    const tx = {
      delete: () => ({ where: async () => {} }),
      insert: () => ({ values: async () => {} }),
    };
    await fn(tx);
    txCommitted++;
  },
  select: () => chain([{ isTest: false }]),
  insert: () => ({
    values: async (v: Record<string, unknown>) => {
      if (failLog) throw new Error("relation agenda_offer_log does not exist");
      logInserts.push(v);
    },
  }),
};

vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return { schema: real.schema, getDb: () => fakeDb };
});

const { replaceOffers } = await import("@/server/agenda/offers");

const SLOTS = [
  { startUtc: "2026-10-20T16:00:00.000Z", label: "mar 20 oct, 10:00" },
  { startUtc: "2026-10-20T17:00:00-00:00", label: "mar 20 oct, 11:00" },
];

beforeEach(() => {
  logInserts.length = 0;
  failLog = false;
  txCommitted = 0;
});

describe("replaceOffers + agenda_offer_log", () => {
  it("registra la ronda tras confirmar la oferta, con is_test de la conversación", async () => {
    await replaceOffers("org_1", "cv_1", SLOTS);
    expect(txCommitted).toBe(1);
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]).toMatchObject({
      organizationId: "org_1",
      conversationId: "cv_1",
      isTest: false,
      slotCount: 2,
      slots: ["2026-10-20T16:00:00.000Z", "2026-10-20T17:00:00.000Z"],
    });
    expect(logInserts[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("un fallo del registro NO rompe la oferta", async () => {
    failLog = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(replaceOffers("org_1", "cv_1", SLOTS)).resolves.toBeUndefined();
    expect(txCommitted).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("con 0 slots no se registra nada", async () => {
    await replaceOffers("org_1", "cv_1", []);
    expect(txCommitted).toBe(1);
    expect(logInserts).toHaveLength(0);
  });
});
