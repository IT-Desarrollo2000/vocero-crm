import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 03 — `resetTestContact` borra notas y ficha: su guarda no confía en el
 * llamador. Solo actúa sobre un contacto ARCHIVADO cuya identidad o teléfono
 * es de una persona sintética del Laboratorio.
 */

let contactRows: unknown[] = [];
const updates: Record<string, unknown>[] = [];
const deletes: string[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit"]) c[m] = () => c;
      (c as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        Promise.resolve(contactRows).then(resolve);
      return c;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve([]) };
      },
    }),
    delete: () => {
      deletes.push("ficha_event");
      return { where: () => Promise.resolve([]) };
    },
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
    }
  ),
}));

import { resetTestContact } from "@/server/bot/ficha";
import { PERSONAS } from "@/server/lab/personas";

const SINTETICO = PERSONAS[0]!.phone;

describe("resetTestContact — guarda", () => {
  beforeEach(() => {
    updates.length = 0;
    deletes.length = 0;
    contactRows = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("persona sintética archivada → un solo update con la semilla", async () => {
    contactRows = [{ archivedAt: new Date(), waIdentity: SINTETICO, phone: SINTETICO }];
    const ok = await resetTestContact({
      organizationId: "org_1",
      contactId: "ct_lab",
      seed: { ficha: { modelo_interes: "Leapmotor T03" }, notes: "[IA] semilla" },
    });
    expect(ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      notes: "[IA] semilla",
      ficha: { modelo_interes: "Leapmotor T03" },
      // 04 — la procedencia y la bitácora tampoco se heredan entre casos.
      fichaMeta: null,
    });
    expect(deletes).toEqual(["ficha_event"]);
  });

  it("sin semilla → notas y ficha vacías", async () => {
    contactRows = [{ archivedAt: new Date(), waIdentity: SINTETICO, phone: SINTETICO }];
    await resetTestContact({ organizationId: "org_1", contactId: "ct_lab" });
    expect(updates[0]).toMatchObject({ notes: null, ficha: null });
  });

  it("contacto real NO archivado → no toca nada y avisa", async () => {
    contactRows = [{ archivedAt: null, waIdentity: SINTETICO, phone: SINTETICO }];
    const ok = await resetTestContact({ organizationId: "org_1", contactId: "ct_x" });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("archivado pero con identidad que NO es de una persona sintética → no toca nada", async () => {
    contactRows = [{ archivedAt: new Date(), waIdentity: "5219991234567", phone: "5219991234567" }];
    const ok = await resetTestContact({ organizationId: "org_1", contactId: "ct_x" });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("contacto inexistente en la organización → no toca nada", async () => {
    const ok = await resetTestContact({ organizationId: "org_1", contactId: "ct_ajeno" });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

describe("persona cliente_que_regresa", () => {
  it("existe, trae semilla y su teléfono es sintético único", () => {
    const p = PERSONAS.find((x) => x.key === "cliente_que_regresa");
    expect(p?.seed?.ficha?.modelo_interes).toBe("Leapmotor T03");
    expect(p?.seed?.notes).toContain("[IA]");
    expect(new Set(PERSONAS.map((x) => x.phone)).size).toBe(PERSONAS.length);
  });
});
