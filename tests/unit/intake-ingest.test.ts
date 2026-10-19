import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 011 — Atomicidad de la ingesta: la tarjeta y el update de la Bandeja van en
 * UNA transacción. Si el update falla, la ingesta falla (el endpoint da 500 y
 * el reintento del ERP no cae en `duplicate`), sin pasos accesorios ni
 * `publish`. Y los pasos accesorios solo loguean el mensaje del error.
 */

const state = vi.hoisted(() => ({
  inserted: [] as unknown[],
  updateFails: false,
  calls: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const schema = await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  const chain = (label: string, result: () => Promise<unknown>) => {
    const p = {
      values: () => p,
      onConflictDoNothing: () => p,
      returning: () => result(),
      set: () => p,
      where: () => result(),
    };
    state.calls.push(label);
    return p;
  };
  const tx = {
    insert: () => chain("tx.insert", async () => state.inserted),
    update: () =>
      chain("tx.update", async () => {
        if (state.updateFails) throw new Error("update caído");
        return [];
      }),
  };
  const db = {
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      state.calls.push("transaction");
      return fn(tx);
    },
    insert: () => chain("db.insert", async () => []),
    update: () => chain("db.update", async () => []),
  };
  return { getDb: () => db, schema };
});
vi.mock("@/server/inbox/archive", () => ({ UNARCHIVE_SET: {} }));
vi.mock("@/server/inbox/identity", () => ({
  getOrCreateContactByIdentity: vi.fn(async () => ({
    contact: {
      id: "ct_1",
      name: "525512345678",
      phone: "525512345678",
      waIdentity: "525512345678",
      channel: "whatsapp",
      source: null,
    },
    isNew: true,
  })),
  isFallbackName: vi.fn(() => false),
}));
vi.mock("@/server/inbox/ingest", () => ({
  getOrCreateConversation: vi.fn(async () => ({ id: "cv_1" })),
  serializeMessage: (m: unknown) => m,
}));
vi.mock("@/server/inbox/lead-activity", () => ({ createLeadForContact: vi.fn() }));
vi.mock("@/server/bot/ficha", () => ({ upsertFicha: vi.fn() }));
vi.mock("@/server/ficha-fields", () => ({ getFichaFields: vi.fn(async () => []) }));
vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/server/intake/settings", () => ({ recordIntakeReceived: vi.fn() }));

import { publish } from "@/server/events/bus";
import { isFallbackName } from "@/server/inbox/identity";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { intakeLeadSchema } from "@/server/intake/contract";
import { ingestExternalLead } from "@/server/intake/ingest";
import { recordIntakeReceived } from "@/server/intake/settings";

const LEAD = intakeLeadSchema.parse({
  lead_id: "6f1c2b9e-3d4a-4e5f-8a7b-1c2d3e4f5a6b",
  origin: "website",
  first_name: "Ana",
  phone: "5512345678",
  email: "ana@example.com",
  notes: "dato privado del prospecto",
});

describe("011 — ingesta: tarjeta + Bandeja en una transacción", () => {
  beforeEach(() => {
    state.inserted = [{ id: "msg_1", conversationId: "cv_1" }];
    state.updateFails = false;
    state.calls = [];
    vi.clearAllMocks();
  });

  it("caso feliz: insert y update DENTRO de la transacción; publish después", async () => {
    const r = await ingestExternalLead("org_1", LEAD, "525512345678");
    expect(r).toMatchObject({ duplicate: false, created: true, conversationId: "cv_1" });
    expect(state.calls.slice(0, 3)).toEqual(["transaction", "tx.insert", "tx.update"]);
    expect(state.calls).not.toContain("db.insert");
    expect(createLeadForContact).toHaveBeenCalledOnce();
    expect(recordIntakeReceived).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("si el update de la Bandeja falla, la ingesta falla: sin accesorios ni publish", async () => {
    state.updateFails = true;
    await expect(ingestExternalLead("org_1", LEAD, "525512345678")).rejects.toThrow(
      "update caído"
    );
    expect(createLeadForContact).not.toHaveBeenCalled();
    expect(recordIntakeReceived).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("duplicado: sin update de la Bandeja, sin accesorios ni publish", async () => {
    state.inserted = [];
    const r = await ingestExternalLead("org_1", LEAD, "525512345678");
    expect(r.duplicate).toBe(true);
    expect(state.calls).not.toContain("tx.update");
    expect(createLeadForContact).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("sin nombre: el contacto conserva su nombre de respaldo (no se toca)", async () => {
    vi.mocked(isFallbackName).mockReturnValue(true);
    const noName = intakeLeadSchema.parse({
      lead_id: "7a1c2b9e-3d4a-4e5f-8a7b-1c2d3e4f5a6b",
      origin: "fast_app",
      first_name: "",
      phone: "5512345678",
    });
    const r = await ingestExternalLead("org_1", noName, "525512345678");
    expect(r.duplicate).toBe(false);
    // Antes de la transacción no hubo update del contacto (el nombre).
    expect(state.calls.slice(0, state.calls.indexOf("transaction"))).not.toContain("db.update");
    vi.mocked(isFallbackName).mockReturnValue(false);
  });

  it("con nombre y nombre de respaldo, el nombre del lead va al contacto", async () => {
    vi.mocked(isFallbackName).mockReturnValue(true);
    await ingestExternalLead("org_1", LEAD, "525512345678");
    expect(state.calls.slice(0, state.calls.indexOf("transaction"))).toContain("db.update");
    vi.mocked(isFallbackName).mockReturnValue(false);
  });

  it("un paso accesorio que falla se anota con SOLO el mensaje y la ingesta sigue", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("lead caído"), { payload: LEAD });
    vi.mocked(createLeadForContact).mockRejectedValueOnce(err);
    vi.mocked(recordIntakeReceived).mockRejectedValueOnce({ notes: LEAD.notes });
    const r = await ingestExternalLead("org_1", LEAD, "525512345678");
    expect(r.duplicate).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    const logged = spy.mock.calls;
    expect(logged).toHaveLength(2);
    expect(logged[0]?.[1]).toBe("lead caído");
    expect(logged[1]?.[1]).toBe("desconocido");
    const all = JSON.stringify(logged);
    expect(all).not.toContain("dato privado");
    expect(all).not.toContain("ana@example.com");
    expect(all).toContain("··5678");
    spy.mockRestore();
  });
});
