import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * 10 — El almacén de recordatorios contra una BD simulada que imita
 * Postgres en lo que importa: `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * sobre el UNIQUE `booking_reminder_claim_uq` (la segunda inserción de la
 * misma terna devuelve `[]`) y el `UPDATE … WHERE status='failed' AND
 * attempts <= 1 RETURNING` del reintento. Se afirma además el SQL real del
 * WHERE (tenant, estado, tope) renderizándolo con el dialecto de Postgres.
 */

const dialect = new PgDialect();
const taken = new Set<string>();
const inserted: Record<string, unknown>[] = [];
const conflictTargets: unknown[] = [];
const updates: { set: Record<string, unknown>; where: SQL }[] = [];
let updateReturns: unknown[] = [];

const fakeDb = {
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: (opts: { target: unknown }) => {
        conflictTargets.push(opts.target);
        return {
          returning: async () => {
            const key = `${v.bookingId}|${v.offsetMinutes}|${(v.scheduledFor as Date).getTime()}`;
            if (taken.has(key)) return [];
            taken.add(key);
            inserted.push(v);
            return [{ id: v.id }];
          },
        };
      },
    }),
  }),
  update: () => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: SQL) => {
        updates.push({ set, where });
        return { returning: async () => updateReturns };
      },
    }),
  }),
};

vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return { schema: real.schema, getDb: () => fakeDb };
});

let n = 0;
vi.mock("@/lib/db/ids", () => ({ newId: () => `brm_${++n}` }));

const store = await import("@/server/agenda/reminder-store");

const render = (s: SQL) => dialect.sqlToQuery(s);

beforeEach(() => {
  taken.clear();
  inserted.length = 0;
  conflictTargets.length = 0;
  updates.length = 0;
  updateReturns = [];
});

const NOW = new Date("2026-10-19T16:01:00.000Z");
const claim = (over: Partial<Parameters<typeof store.insertReminderClaim>[0]> = {}) =>
  store.insertReminderClaim({
    organizationId: "org_1",
    bookingId: "bk_1",
    offsetMinutes: 1440,
    scheduledFor: new Date("2026-10-20T16:00:00.000Z"),
    templateId: "tpl_1",
    now: NOW,
    ...over,
  });

describe("insertReminderClaim", () => {
  it("dos claims concurrentes de la misma terna: uno gana, el otro null", async () => {
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });

  it("nace en `sending` con claimed_at = now de JS y ON CONFLICT sobre la terna", async () => {
    await claim();
    expect(inserted[0]).toMatchObject({
      status: "sending",
      attempts: 1,
      claimedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const target = conflictTargets[0] as { name: string }[];
    expect(target.map((c) => c.name)).toEqual([
      "booking_id",
      "offset_minutes",
      "scheduled_for",
    ]);
  });

  it("otra hora (reprogramada) u otra anticipación = otra clave", async () => {
    expect(await claim()).not.toBeNull();
    expect(await claim({ scheduledFor: new Date("2026-10-23T16:00:00.000Z") })).not.toBeNull();
    expect(await claim({ offsetMinutes: 120 })).not.toBeNull();
  });
});

describe("claimReminderRetry", () => {
  it("UPDATE condicionado: tenant, id, cita, status='failed' y attempts <= 1", async () => {
    updateReturns = [{ id: "brm_1" }];
    const ok = await store.claimReminderRetry({
      organizationId: "org_1",
      bookingId: "bk_1",
      reminderId: "brm_1",
      now: NOW,
    });
    expect(ok).toBe(true);
    const q = render(updates[0]!.where);
    expect(q.sql).toContain('"booking_reminder"."organization_id" = $1');
    expect(q.sql).toContain('"booking_reminder"."status" = $4');
    expect(q.sql).toContain('"booking_reminder"."attempts" <= $5');
    expect(q.params).toEqual(["org_1", "brm_1", "bk_1", "failed", 1]);
    expect(updates[0]!.set).toMatchObject({ status: "sending", claimedAt: NOW });
  });

  it("sin fila devuelta (otro clic ganó o ya se usó) → false", async () => {
    updateReturns = [];
    expect(
      await store.claimReminderRetry({ organizationId: "org_1", bookingId: "bk_1", reminderId: "brm_1", now: NOW })
    ).toBe(false);
  });
});

describe("markStuckReminders", () => {
  it("solo `sending` con claimed_at anterior a now − 10 min; error 'interrumpido'", async () => {
    updateReturns = [{ id: "brm_1", bookingId: "bk_1", organizationId: "org_1" }];
    const rows = await store.markStuckReminders(NOW, "org_1");
    expect(rows).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ status: "failed", error: "interrumpido", updatedAt: NOW });
    const q = render(updates[0]!.where);
    expect(q.params).toContain("sending");
    expect(q.params).toContain("org_1");
    expect(q.sql).toContain('"booking_reminder"."claimed_at" < $');
  });
});

describe("normalización de ajustes", () => {
  it("anticipaciones ilegibles → default; mapeo con un campo fuera del catálogo → vacío", () => {
    expect(store.normalizeOffsets("x")).toEqual([1440]);
    expect(store.normalizeOffsets([120, 120, -1])).toEqual([120]);
    expect(store.normalizeVariables(["contact_name", "booking_datetime"])).toEqual([
      "contact_name",
      "booking_datetime",
    ]);
    expect(store.normalizeVariables(["contact_name", "telefono"])).toEqual([]);
  });
});
