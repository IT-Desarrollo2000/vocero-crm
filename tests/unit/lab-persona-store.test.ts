import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 08 — `ensureSeedPersonas` (D-08-01) y `loadRunPersonas` con BD simulada:
 * cada `select` consume la siguiente respuesta de `selectQueue`; los
 * `insert` se registran.
 */

let selectQueue: unknown[][] = [];
const inserts: { values: unknown[]; onConflict: boolean }[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => {
      const rows = selectQueue.shift() ?? [];
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit", "orderBy"]) c[m] = () => c;
      (c as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        Promise.resolve(rows).then(resolve);
      return c;
    },
    insert: () => ({
      values: (values: unknown[]) => {
        const entry = { values, onConflict: false };
        inserts.push(entry);
        return {
          onConflictDoNothing: () => {
            entry.onConflict = true;
            return Promise.resolve([]);
          },
        };
      },
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
    }
  ),
}));

import { LabError } from "@/server/lab/errors";
import { ensureSeedPersonas, loadRunPersonas } from "@/server/lab/persona-store";
import { PERSONAS, PERSONAS_NEUTRO } from "@/server/lab/personas";

beforeEach(() => {
  selectQueue = [];
  inserts.length = 0;
});

describe("ensureSeedPersonas (D-08-01)", () => {
  it("org que ya tiene personas → no siembra", async () => {
    selectQueue = [[{ id: "lpe_1" }]];
    expect(await ensureSeedPersonas("org_1")).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("org sin personas y con corridas → set autos (las 7 de siempre), ON CONFLICT DO NOTHING", async () => {
    selectQueue = [[], [{ id: "run_1" }]];
    expect(await ensureSeedPersonas("org_1")).toBe("autos");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.onConflict).toBe(true);
    const rows = inserts[0]!.values as Record<string, unknown>[];
    expect(rows.map((r) => r.key)).toEqual(PERSONAS.map((p) => p.key));
    expect(rows[0]).toMatchObject({
      organizationId: "org_1",
      seedSet: "autos",
      name: "Comprador decidido",
      phone: "5210000000001",
      guion: PERSONAS[0]!.script,
      expectFicha: [
        { key: "modelo_interes", pattern: "t03", flags: "i" },
        { key: "ciudad", pattern: "villahermosa", flags: "i" },
      ],
      position: 0,
      active: true,
    });
    expect(String(rows[0]!.id)).toMatch(/^lpe_/);
    const regresa = rows.find((r) => r.key === "cliente_que_regresa");
    expect(regresa?.seed).toMatchObject({ notes: expect.stringContaining("[IA]") });
  });

  it("org nueva (sin corridas) → set neutro", async () => {
    selectQueue = [[], []];
    expect(await ensureSeedPersonas("org_2")).toBe("neutro");
    const rows = inserts[0]!.values as Record<string, unknown>[];
    expect(rows).toHaveLength(PERSONAS_NEUTRO.length);
    expect(rows.every((r) => r.seedSet === "neutro")).toBe(true);
  });
});

const row = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `lpe_${key}`,
  key,
  name: key,
  objetivo: "",
  rasgos: null,
  guion: ["Hola"],
  criteriosExito: null,
  contactName: `[Prueba] ${key}`,
  phone: "5210000000001",
  seed: null,
  expectFicha: [{ key: "ciudad", pattern: "villa", flags: "i" }],
  seedSet: null,
  active: true,
  position: 0,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

describe("loadRunPersonas", () => {
  it("devuelve LabPersona con expectFicha compilado", async () => {
    selectQueue = [[row("a")]];
    const [p] = await loadRunPersonas("org_1");
    expect(p?.key).toBe("a");
    expect(p?.expectFicha?.ciudad?.test("Villahermosa")).toBe(true);
    expect(p?.seed).toBeUndefined();
  });

  it("sin personas activas → no_personas; claves vacías → no_personas", async () => {
    selectQueue = [[]];
    await expect(loadRunPersonas("org_1")).rejects.toMatchObject({ code: "no_personas" });
    await expect(loadRunPersonas("org_1", [])).rejects.toBeInstanceOf(LabError);
  });

  it("clave pedida que no está activa → unknown_persona", async () => {
    selectQueue = [[row("a")]];
    await expect(loadRunPersonas("org_1", ["a", "b"])).rejects.toMatchObject({
      code: "unknown_persona",
    });
  });
});
