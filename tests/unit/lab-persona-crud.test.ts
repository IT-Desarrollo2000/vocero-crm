import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 08 — Personas del Laboratorio (regla 1 y 2 del contrato, RF-08-03/05):
 * clave slug única e inmutable, teléfono sintético generado por el servidor,
 * archivado idempotente y "restaurar predeterminadas" idempotente.
 * BD simulada: cada `select` consume `selectQueue`; se registran inserts,
 * updates y los `execute` (candado consultivo).
 */

let selectQueue: unknown[][] = [];
const inserts: { table: string; values: unknown }[] = [];
const updates: { table: string; set: Record<string, unknown> }[] = [];
const executes: unknown[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) c[m] = () => c;
  (c as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return c;
}

const db = {
  select: () => chain(selectQueue.shift() ?? []),
  execute: (q: unknown) => {
    executes.push(q);
    return Promise.resolve([]);
  },
  insert: (table: { __name: string }) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table: table.__name, values });
      const row = { archivedAt: null, createdAt: new Date(), updatedAt: new Date(), seed: null, seedSet: null, ...values };
      const c = {
        onConflictDoNothing: () => c,
        returning: () => Promise.resolve([row]),
        then: (resolve: (v: unknown) => void) => Promise.resolve([row]).then(resolve),
      };
      return c;
    },
  }),
  update: (table: { __name: string }) => ({
    set: (set: Record<string, unknown>) => ({
      where: () => {
        updates.push({ table: table.__name, set });
        const rows = updateReturns.shift() ?? [];
        const c = {
          returning: () => Promise.resolve(rows),
          then: (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve),
        };
        return c;
      },
    }),
  }),
};
let updateReturns: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({ ...db, transaction: (fn: (tx: typeof db) => unknown) => fn(db) }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__name" ? String(tableName) : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

import {
  archivePersona,
  createPersona,
  nextSyntheticPhone,
  planRestore,
  restoreDefaultPersonas,
  slugKey,
  uniqueKey,
  updatePersona,
} from "@/server/lab/persona-store";
import { PERSONAS, PERSONAS_NEUTRO, isSyntheticLabPhone } from "@/server/lab/personas";
import { personaCreateSchema } from "@/server/lab/schemas";

beforeEach(() => {
  selectQueue = [];
  updateReturns = [];
  inserts.length = 0;
  updates.length = 0;
  executes.length = 0;
});

describe("clave de la persona (regla 2)", () => {
  it("slug del nombre sin acentos ni signos", () => {
    expect(slugKey("Pregunta por garantía extendida")).toBe("pregunta_por_garantia_extendida");
    expect(slugKey("  ¿Cliente VIP? ñandú  ")).toBe("cliente_vip_nandu");
    expect(slugKey("!!!")).toBe("persona");
    expect(slugKey("x".repeat(80))).toHaveLength(48);
  });

  it("sufijo _2, _3… si choca con otra (aunque archivada) o con una clave de semilla", () => {
    expect(uniqueKey("garantia", new Set())).toBe("garantia");
    expect(uniqueKey("garantia", new Set(["garantia"]))).toBe("garantia_2");
    expect(uniqueKey("garantia", new Set(["garantia", "garantia_2"]))).toBe("garantia_3");
    // Clave de semilla: reservada aunque la org no la tenga.
    expect(uniqueKey("pide_humano", new Set())).toBe("pide_humano_2");
  });
});

describe("teléfono sintético (regla 1)", () => {
  it("siguiente a la mayor secuencia de la org, nunca por debajo de las semillas", () => {
    expect(nextSyntheticPhone([])).toBe("5210000000008");
    expect(nextSyntheticPhone(PERSONAS.map((p) => p.phone))).toBe("5210000000008");
    expect(nextSyntheticPhone(["5210000000001", "5210000000012", "5219991234567"])).toBe(
      "5210000000013"
    );
    expect(isSyntheticLabPhone(nextSyntheticPhone([]))).toBe(true);
  });
});

describe("createPersona", () => {
  it("genera key y teléfono en el servidor (los del body se descartan) y la pone al final", async () => {
    const parsed = personaCreateSchema.parse({
      name: "Garantía extendida",
      guion: ["Hola", "¿Tienen garantía extendida?"],
      key: "comprador_decidido",
      phone: "5215555555555",
    });
    selectQueue = [
      [
        { key: "comprador_decidido", phone: "5210000000001", position: 0 },
        { key: "garantia_extendida", phone: "5210000000009", position: 7 }, // archivada
      ],
    ];
    const p = await createPersona("org_1", parsed);
    expect(executes).toHaveLength(1); // candado consultivo por org
    expect(p.key).toBe("garantia_extendida_2");
    expect(p.phone).toBe("5210000000010");
    expect(p.position).toBe(8);
    expect(p.contactName).toBe("[Prueba] Garantía extendida");
    expect(p.seedSet).toBeNull();
    expect(p.active).toBe(true);
    expect(p.guion).toEqual(["Hola", "¿Tienen garantía extendida?"]);
  });
});

describe("updatePersona / archivePersona", () => {
  it("editar no toca key ni phone; 404 si no es de la org", async () => {
    updateReturns = [[{ id: "lpe_1", key: "k", name: "Nuevo", objetivo: "", rasgos: null, guion: ["a"], criteriosExito: null, contactName: "c", phone: "5210000000008", seed: null, expectFicha: [], active: true, position: 0, seedSet: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date() }]];
    const p = await updatePersona("org_1", "lpe_1", { name: "Nuevo", key: "otra", phone: "1" } as never);
    expect(p.name).toBe("Nuevo");
    expect(updates[0]!.set).not.toHaveProperty("key");
    expect(updates[0]!.set).not.toHaveProperty("phone");
    expect(updates[0]!.set).toMatchObject({ name: "Nuevo" });

    await expect(updatePersona("org_1", "ajena", { name: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("archivar = archived_at (conservando la fecha si ya estaba) + inactiva", async () => {
    const archivedAt = new Date("2026-10-01T00:00:00Z");
    updateReturns = [[{ id: "lpe_1", key: "k", name: "n", objetivo: "", rasgos: null, guion: ["a"], criteriosExito: null, contactName: "c", phone: "5210000000008", seed: null, expectFicha: [], active: false, position: 0, seedSet: null, archivedAt, createdAt: new Date(), updatedAt: new Date() }]];
    const p = await archivePersona("org_1", "lpe_1");
    expect(p.archivedAt).toBe(archivedAt.toISOString());
    expect(updates[0]!.set.active).toBe(false);
    // coalesce(archived_at, now()): SQL, no una fecha nueva desde JS.
    expect(updates[0]!.set.archivedAt).not.toBeInstanceOf(Date);
    await expect(archivePersona("org_1", "ajena")).rejects.toMatchObject({ code: "not_found" });
  });
});

const seedRowOf = (key: string, set: "autos" | "neutro", extra: Record<string, unknown> = {}) => ({
  key,
  seedSet: set,
  active: true,
  archivedAt: null,
  ...extra,
});

describe("planRestore / restoreDefaultPersonas (RF-08-03)", () => {
  it("mismo set y todo activo → nada (idempotente)", () => {
    expect(planRestore("autos", PERSONAS.map((p) => seedRowOf(p.key, "autos")))).toEqual([]);
  });

  it("faltante → insert; archivada/inactiva → reactivate; otro set → rewrite", () => {
    const rows = PERSONAS.filter((p) => p.key !== "pide_humano").map((p) =>
      p.key === "fuera_de_kb"
        ? seedRowOf(p.key, "autos", { archivedAt: new Date(), active: false })
        : p.key === "cliente_enojado"
          ? seedRowOf(p.key, "neutro")
          : seedRowOf(p.key, "autos")
    );
    expect(planRestore("autos", rows)).toEqual([
      { key: "cliente_enojado", action: "rewrite" },
      { key: "fuera_de_kb", action: "reactivate" },
      { key: "pide_humano", action: "insert" },
    ]);
  });

  it("restaurar con set distinto reescribe el contenido de las semillas (incl. expectFicha) y deja las personalizadas", async () => {
    const neutroRows = PERSONAS_NEUTRO.map((p) => ({ ...seedRowOf(p.key, "neutro"), id: `lpe_${p.key}` }));
    const custom = { key: "garantia", seedSet: null, active: true, archivedAt: null, id: "lpe_g" };
    selectQueue = [[...neutroRows, custom], []]; // filas de la org · listPersonas
    const r = await restoreDefaultPersonas("org_1", "autos");
    expect(r.set).toBe("autos");
    expect(r.restored).toEqual(PERSONAS.map((p) => p.key));
    expect(updates).toHaveLength(7);
    const comprador = updates[0]!.set;
    expect(comprador).toMatchObject({
      seedSet: "autos",
      guion: PERSONAS[0]!.script,
      expectFicha: [
        { key: "modelo_interes", pattern: "t03", flags: "i" },
        { key: "ciudad", pattern: "villahermosa", flags: "i" },
      ],
      active: true,
      archivedAt: null,
    });
    expect(comprador).not.toHaveProperty("key");
    expect(comprador).not.toHaveProperty("position");
    expect(inserts).toHaveLength(0);
  });

  it("sin set pedido usa el de la org; dos veces seguidas → la segunda no restaura nada", async () => {
    const rows = PERSONAS_NEUTRO.map((p) =>
      p.key === "errores_modismos"
        ? seedRowOf(p.key, "neutro", { archivedAt: new Date(), active: false })
        : seedRowOf(p.key, "neutro")
    );
    selectQueue = [rows, []];
    const first = await restoreDefaultPersonas("org_1");
    expect(first).toMatchObject({ set: "neutro", restored: ["errores_modismos"] });
    expect(updates[0]!.set).toMatchObject({ active: true, archivedAt: null });
    expect(updates[0]!.set).not.toHaveProperty("guion");

    updates.length = 0;
    selectQueue = [PERSONAS_NEUTRO.map((p) => seedRowOf(p.key, "neutro")), []];
    const second = await restoreDefaultPersonas("org_1");
    expect(second.restored).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it("org sin personas: D-08-01 decide el set (con corridas → autos) e inserta las 7", async () => {
    selectQueue = [[], [{ id: "run_1" }], []];
    const r = await restoreDefaultPersonas("org_1");
    expect(r.set).toBe("autos");
    expect(inserts).toHaveLength(7);
    expect(inserts.every((i) => (i.values as { seedSet: string }).seedSet === "autos")).toBe(true);
  });
});
