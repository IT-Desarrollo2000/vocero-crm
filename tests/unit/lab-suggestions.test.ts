import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 08 — Aplicar sugerencias del juez (RF-08-12/13): idempotencia por
 * (caso, hallazgo), append al perfil con límites y rollback, y validaciones.
 * BD simulada: cada `select` consume `selectQueue`; cada `insert … returning`
 * consume `insertQueue` (si está vacía, devuelve los valores insertados).
 */

let selectQueue: unknown[][] = [];
let insertQueue: unknown[][] = [];
const inserts: { table: string; values: Record<string, unknown> }[] = [];
const updates: { table: string; set: Record<string, unknown> }[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy", "for"]) c[m] = () => c;
  (c as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return c;
}

const db = {
  select: () => chain(selectQueue.shift() ?? []),
  insert: (table: { __name: string }) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table: table.__name, values });
      const result = () => insertQueue.shift() ?? [values];
      const c = {
        onConflictDoNothing: () => c,
        returning: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => void) => Promise.resolve(result()).then(resolve),
      };
      return c;
    },
  }),
  update: (table: { __name: string }) => ({
    set: (set: Record<string, unknown>) => ({
      where: () => {
        updates.push({ table: table.__name, set });
        const c = {
          returning: () => Promise.resolve([]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve),
        };
        return c;
      },
    }),
  }),
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    ...db,
    // La transacción corre el callback con el mismo cliente simulado; un
    // throw dentro "revierte" (las capturas se descartan en cada prueba).
    transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  }),
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
  appendToField,
  applySuggestion,
  hallazgosDto,
  readHallazgos,
} from "@/server/lab/suggestions";

const HALLAZGOS = [
  {
    tipo: "fuera_de_kb",
    evidencia: "preguntó por garantías",
    sugerencia: { pregunta: "¿Garantía?", respuesta: "30 días" },
  },
  {
    tipo: "tono",
    evidencia: "seco",
    ajuste: { campo: "tone", texto: "Sé cálido." },
  },
];
const CASE = { id: "case_1", hallazgos: HALLAZGOS };
const appRow = (extra: Record<string, unknown> = {}) => ({
  id: "lsa_1",
  organizationId: "org_1",
  testCaseId: "case_1",
  hallazgoIndex: 0,
  target: "kb",
  field: null,
  kbEntryId: "kb_1",
  appliedText: "30 días",
  actorUserId: "u_1",
  createdAt: new Date("2026-10-12T00:00:00Z"),
  ...extra,
});

beforeEach(() => {
  selectQueue = [];
  insertQueue = [];
  inserts.length = 0;
  updates.length = 0;
});

describe("appendToField (D-08-02)", () => {
  it("agrega con salto de línea; vacío → el texto solo", () => {
    expect(appendToField("Amable.", "Sé cálido.", 500)).toEqual({
      value: "Amable.\nSé cálido.",
      changed: true,
    });
    expect(appendToField(null, "  Sé cálido. ", 500)).toEqual({ value: "Sé cálido.", changed: true });
  });

  it("ya contenido → sin cambio (no duplica)", () => {
    expect(appendToField("Amable.\nSé cálido.", "Sé cálido.", 500)).toEqual({
      value: "Amable.\nSé cálido.",
      changed: false,
    });
  });

  it("excede el límite → too_long", () => {
    expect(() => appendToField("x".repeat(495), "abcdef", 500)).toThrow(
      expect.objectContaining({ code: "too_long" })
    );
  });
});

describe("readHallazgos / hallazgosDto", () => {
  it("conserva el índice; un ajuste con campo inválido se descarta solo", () => {
    const h = readHallazgos([
      { tipo: "tono", evidencia: "x", ajuste: { campo: "greeting", texto: "hola" } },
      "basura",
      HALLAZGOS[1],
    ]);
    expect(h[0]).toEqual({ tipo: "tono", evidencia: "x" });
    expect(h[1]).toBeNull();
    expect(h[2]?.ajuste).toEqual({ campo: "tone", texto: "Sé cálido." });
  });

  it("aplicada por (caso, índice); ninguno se omite", () => {
    const applied = new Map([
      ["case_1:1", { target: "profile" as const, field: "tone" as const, kbEntryId: null, appliedText: "Sé cálido.", appliedAt: "t" }],
    ]);
    const dto = hallazgosDto("case_1", HALLAZGOS, applied);
    expect(dto).toHaveLength(2);
    expect(dto[0]!.aplicada).toBeNull();
    expect(dto[1]!.aplicada).toMatchObject({ target: "profile", field: "tone" });
    expect(hallazgosDto("case_1", null, applied)).toEqual([]);
  });
});

describe("applySuggestion", () => {
  it("kb: primera vez crea la entrada qa y liga el registro", async () => {
    selectQueue = [[CASE]];
    insertQueue = [[appRow({ kbEntryId: null })], [{ id: "kb_nuevo" }]];
    const r = await applySuggestion("org_1", "u_1", {
      testCaseId: "case_1",
      hallazgoIndex: 0,
      target: "kb",
    });
    expect(r.result).toBe("applied");
    expect(inserts.map((i) => i.table)).toEqual(["labSuggestionApplication", "kbEntry"]);
    expect(inserts[1]!.values).toMatchObject({ kind: "qa", question: "¿Garantía?", answer: "30 días" });
    expect(updates).toEqual([
      { table: "labSuggestionApplication", set: { kbEntryId: "kb_nuevo" } },
    ]);
  });

  it("kb: segunda vez (ON CONFLICT sin fila) → alreadyApplied, sin crear entrada", async () => {
    selectQueue = [[CASE], [appRow()]];
    insertQueue = [[]];
    const r = await applySuggestion("org_1", "u_1", {
      testCaseId: "case_1",
      hallazgoIndex: 0,
      target: "kb",
    });
    expect(r).toEqual({
      result: "alreadyApplied",
      application: {
        target: "kb",
        field: null,
        kbEntryId: "kb_1",
        appliedText: "30 días",
        appliedAt: "2026-10-12T00:00:00.000Z",
      },
    });
    expect(inserts.map((i) => i.table)).toEqual(["labSuggestionApplication"]);
    expect(updates).toHaveLength(0);
  });

  it("kb: el texto editado del body manda sobre el del juez", async () => {
    selectQueue = [[CASE]];
    insertQueue = [[appRow({ kbEntryId: null })], [{ id: "kb_2" }]];
    await applySuggestion("org_1", null, {
      testCaseId: "case_1",
      hallazgoIndex: 0,
      target: "kb",
      respuesta: "60 días",
    });
    expect(inserts[0]!.values).toMatchObject({ appliedText: "60 días", actorUserId: null });
    expect(inserts[1]!.values).toMatchObject({ answer: "60 días" });
  });

  it("profile: agrega el ajuste al tono", async () => {
    selectQueue = [[CASE], [{ id: "agp_1", tone: "Amable." }]];
    insertQueue = [[appRow({ hallazgoIndex: 1, target: "profile", field: "tone", kbEntryId: null, appliedText: "Sé cálido." })]];
    const r = await applySuggestion("org_1", "u_1", {
      testCaseId: "case_1",
      hallazgoIndex: 1,
      target: "profile",
    });
    expect(r.result).toBe("applied");
    expect(r.application).toMatchObject({ target: "profile", field: "tone" });
    expect(inserts[0]!.values).toMatchObject({ target: "profile", field: "tone", appliedText: "Sé cálido." });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: "agentProfile", set: { tone: "Amable.\nSé cálido." } });
  });

  it("profile: texto ya contenido → registra la aplicación sin duplicar", async () => {
    selectQueue = [[CASE], [{ id: "agp_1", tone: "Amable.\nSé cálido." }]];
    insertQueue = [[appRow({ hallazgoIndex: 1, target: "profile", field: "tone" })]];
    const r = await applySuggestion("org_1", "u_1", {
      testCaseId: "case_1",
      hallazgoIndex: 1,
      target: "profile",
    });
    expect(r.result).toBe("applied");
    expect(updates).toHaveLength(0);
  });

  it("profile: sin perfil → se crea y recibe el texto", async () => {
    selectQueue = [[CASE], [], [{ id: "agp_new", tone: null }]];
    insertQueue = [[appRow({ hallazgoIndex: 1, target: "profile", field: "tone" })], []];
    await applySuggestion("org_1", "u_1", {
      testCaseId: "case_1",
      hallazgoIndex: 1,
      target: "profile",
    });
    expect(inserts.map((i) => i.table)).toEqual(["labSuggestionApplication", "agentProfile"]);
    expect(updates[0]).toMatchObject({ table: "agentProfile", set: { tone: "Sé cálido." } });
  });

  it("profile: excede el límite → too_long y la transacción revierte (sin update)", async () => {
    selectQueue = [[CASE], [{ id: "agp_1", tone: "x".repeat(495) }]];
    insertQueue = [[appRow({ hallazgoIndex: 1, target: "profile", field: "tone" })]];
    await expect(
      applySuggestion("org_1", "u_1", { testCaseId: "case_1", hallazgoIndex: 1, target: "profile" })
    ).rejects.toMatchObject({ code: "too_long" });
    expect(updates).toHaveLength(0);
  });

  it("caso de otra org → not_found; índice fuera de rango → hallazgo_not_found", async () => {
    selectQueue = [[]];
    await expect(
      applySuggestion("org_1", "u_1", { testCaseId: "ajeno", hallazgoIndex: 0, target: "kb" })
    ).rejects.toMatchObject({ code: "not_found" });
    selectQueue = [[CASE]];
    await expect(
      applySuggestion("org_1", "u_1", { testCaseId: "case_1", hallazgoIndex: 7, target: "kb" })
    ).rejects.toMatchObject({ code: "hallazgo_not_found" });
    expect(inserts).toHaveLength(0);
  });

  it("destino que el hallazgo no trae → target_mismatch, sin registro", async () => {
    selectQueue = [[CASE]];
    await expect(
      applySuggestion("org_1", "u_1", { testCaseId: "case_1", hallazgoIndex: 1, target: "kb" })
    ).rejects.toMatchObject({ code: "target_mismatch" });
    selectQueue = [[CASE]];
    await expect(
      applySuggestion("org_1", "u_1", { testCaseId: "case_1", hallazgoIndex: 0, target: "profile" })
    ).rejects.toMatchObject({ code: "target_mismatch" });
    expect(inserts).toHaveLength(0);
  });
});
