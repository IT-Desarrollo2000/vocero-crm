import { describe, expect, it } from "vitest";
import {
  NOT_IMPLEMENTED_MESSAGE,
  barWidth,
  buildTrendsTable,
  classifyLabError,
  defaultSelection,
  deltaView,
  diffUrl,
  emptyPersonaDraft,
  estimateRunMinutes,
  kbEntryLabel,
  parseSeedFicha,
  personaToDraft,
  pruneSelection,
  runCreateBody,
  summarizeDiff,
  toggleSelection,
  tooLongMessage,
  validateExpectRule,
  validatePersonaDraft,
  type PersonaDraft,
} from "@/components/lab/lab-logic";
import type { LabPersonaDto, LabRunDiffDto, LabTrendsDto } from "@/lib/lab";

function persona(over: Partial<LabPersonaDto> & { key: string }): LabPersonaDto {
  return {
    id: `lpe_${over.key}`,
    name: over.key,
    objetivo: "",
    rasgos: null,
    guion: ["hola"],
    criteriosExito: null,
    contactName: `[Prueba] ${over.key}`,
    phone: "5210000000001",
    seed: null,
    expectFicha: [],
    active: true,
    position: 0,
    seedSet: null,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function draft(over: Partial<PersonaDraft> = {}): PersonaDraft {
  return { ...emptyPersonaDraft(), name: "Garantía", guion: ["¿Tienen garantía?"], ...over };
}

describe("formulario de persona", () => {
  it("arma el cuerpo con trim y nulos donde van", () => {
    const r = validatePersonaDraft(
      draft({
        name: "  Pregunta por garantía extendida ",
        guion: [" Hola ", "¿Cuánto dura?", "Gracias"],
        criteriosExito: "no inventar plazos",
        position: "3",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toEqual({
      name: "Pregunta por garantía extendida",
      objetivo: "",
      rasgos: null,
      guion: ["Hola", "¿Cuánto dura?", "Gracias"],
      criteriosExito: "no inventar plazos",
      seed: null,
      expectFicha: [],
      active: true,
      position: 3,
    });
    expect("contactName" in r.input).toBe(false);
  });

  it("exige nombre y guion de 1..8 mensajes de 1..500", () => {
    const r = validatePersonaDraft(
      draft({ name: " ", guion: ["", "x".repeat(501), ...Array(7).fill("ok")] })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.name).toBeDefined();
    expect(r.errors.guion).toMatch(/8 mensajes/);
    expect(r.errors["guion.0"]).toMatch(/vacío/);
    expect(r.errors["guion.1"]).toMatch(/500/);
    expect(r.errors["guion.2"]).toBeUndefined();

    const sinGuion = validatePersonaDraft(draft({ guion: [] }));
    expect(sinGuion.ok).toBe(false);
    if (!sinGuion.ok) expect(sinGuion.errors.guion).toMatch(/mensaje inicial/);

    expect(validatePersonaDraft(draft({ guion: Array(8).fill("ok") })).ok).toBe(true);
  });

  it("límites de texto y posición", () => {
    const r = validatePersonaDraft(
      draft({
        name: "n".repeat(81),
        objetivo: "o".repeat(1001),
        criteriosExito: "c".repeat(1001),
        position: "-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(
      ["criteriosExito", "name", "objetivo", "position"].sort()
    );
    expect(validatePersonaDraft(draft({ position: "1.5" })).ok).toBe(false);
    expect(validatePersonaDraft(draft({ position: "" })).ok).toBe(true);
  });

  it("valida las reglas de ficha como regex del runtime", () => {
    expect(validateExpectRule({ key: "ciudad", pattern: "villahermosa", flags: "i" })).toBeNull();
    expect(validateExpectRule({ key: "ciudad", pattern: "(", flags: "i" })).toMatch(/inválida/);
    expect(validateExpectRule({ key: "ciudad", pattern: "x", flags: "q" })).toMatch(/Banderas/);
    expect(validateExpectRule({ key: " ", pattern: "x", flags: "" })).toMatch(/clave/);
    expect(validateExpectRule({ key: "k", pattern: "", flags: "" })).toMatch(/patrón/);
    expect(validateExpectRule({ key: "k", pattern: "a".repeat(201), flags: "" })).toMatch(/200/);

    const r = validatePersonaDraft(
      draft({
        expectFicha: [
          { key: "ciudad", pattern: "villa", flags: "i" },
          { key: "modelo", pattern: "[", flags: "" },
        ],
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors["expect.0"]).toBeUndefined();
      expect(r.errors["expect.1"]).toMatch(/inválida/);
    }
    const many = validatePersonaDraft(
      draft({ expectFicha: Array(21).fill({ key: "k", pattern: "x", flags: "" }) })
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.errors.expectFicha).toMatch(/20/);
  });

  it("semilla: ficha `clave: valor`, notas y nombre conservado", () => {
    expect(parseSeedFicha("")).toEqual({ ok: true, ficha: null });
    expect(parseSeedFicha("ciudad: Villahermosa\n\nmodelo:  Seal ")).toEqual({
      ok: true,
      ficha: { ciudad: "Villahermosa", modelo: "Seal" },
    });
    expect(parseSeedFicha("sin separador").ok).toBe(false);
    expect(parseSeedFicha(": valor").ok).toBe(false);

    const p = persona({
      key: "cliente_que_regresa",
      seed: { ficha: { ciudad: "Villahermosa", visitas: 2 }, notes: "Ya vino", name: "Ana" },
      expectFicha: [{ key: "ciudad", pattern: "villa", flags: "i" }],
    });
    const d = personaToDraft(p);
    expect(d.seedFicha).toBe("ciudad: Villahermosa\nvisitas: 2");
    const r = validatePersonaDraft(d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.seed).toEqual({
        ficha: { ciudad: "Villahermosa", visitas: "2" },
        notes: "Ya vino",
        name: "Ana",
      });
      expect(r.input.expectFicha).toEqual([{ key: "ciudad", pattern: "villa", flags: "i" }]);
      expect(r.input.contactName).toBe("[Prueba] cliente_que_regresa");
    }
  });
});

describe("selección de personas por corrida", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    persona({ key: `p${String(i).padStart(2, "0")}`, position: i })
  );

  it("por defecto las activas sin archivar, por posición, tope 10", () => {
    const list = [
      persona({ key: "b", position: 2 }),
      persona({ key: "a", position: 1 }),
      persona({ key: "off", active: false }),
      persona({ key: "old", archivedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(defaultSelection(list)).toEqual({ keys: ["a", "b"], capped: false });
    const capped = defaultSelection(many);
    expect(capped.keys).toHaveLength(10);
    expect(capped.capped).toBe(true);
  });

  it("no deja pasar de 10", () => {
    const ten = defaultSelection(many).keys;
    expect(toggleSelection(ten, "p11")).toEqual({ keys: ten, limited: true });
    const nine = toggleSelection(ten, "p00");
    expect(nine.keys).toHaveLength(9);
    expect(toggleSelection(nine.keys, "p11").keys).toContain("p11");
  });

  it("poda lo que dejó de ser elegible", () => {
    const list = [persona({ key: "a" }), persona({ key: "b", active: false })];
    expect(pruneSelection(["a", "b", "x"], list)).toEqual(["a"]);
  });

  it("cuerpo de la corrida: sin cuerpo si son todas o si no hay lista", () => {
    const list = [persona({ key: "a", position: 0 }), persona({ key: "b", position: 1 })];
    expect(runCreateBody(["a"], null)).toBeNull();
    expect(runCreateBody(["b", "a"], list)).toBeNull();
    expect(runCreateBody(["b"], list)).toEqual({ personaKeys: ["b"] });
    expect(runCreateBody([], list)).toEqual({ personaKeys: [] });
    // Más de 10 activas: "todas" no cabe en una corrida → lista explícita.
    expect(runCreateBody(defaultSelection(many).keys, many)?.personaKeys).toHaveLength(10);
  });

  it("estima la duración", () => {
    expect(estimateRunMinutes([])).toBe(0);
    expect(estimateRunMinutes([{ guion: ["a"] }])).toBe(1);
    expect(estimateRunMinutes(Array(10).fill({ guion: Array(8).fill("x") }))).toBe(17);
  });
});

describe("errores de /api/lab/*", () => {
  it("501 → Disponible pronto; 409/422/404 con su mensaje", () => {
    expect(classifyLabError(501, null)).toEqual({
      kind: "not_implemented",
      message: NOT_IMPLEMENTED_MESSAGE,
    });
    expect(
      classifyLabError(409, { error: { code: "run_in_progress", message: "Ya hay una corrida" } })
    ).toEqual({ kind: "conflict", code: "run_in_progress", message: "Ya hay una corrida" });
    expect(classifyLabError(422, { error: { code: "no_personas", message: "Sin personas" } }).kind).toBe(
      "invalid"
    );
    expect(classifyLabError(422, { error: { code: "too_long", message: "x" } }).kind).toBe("too_long");
    expect(classifyLabError(404, null).kind).toBe("not_found");
    expect(classifyLabError(500, "nope", "Falló")).toEqual({ kind: "error", message: "Falló" });
  });

  it("too_long nombra el campo y su límite", () => {
    expect(tooLongMessage("tone")).toMatch(/Tono.*500/);
    expect(tooLongMessage("escalationRules")).toMatch(/escalamiento.*4000/);
  });
});

describe("historial: delta", () => {
  it("delta numérico, conjunto distinto o nada", () => {
    expect(deltaView({ delta: 5, deltaNote: null })?.label).toBe("+5");
    expect(deltaView({ delta: -3, deltaNote: null })).toMatchObject({ kind: "down", label: "-3" });
    expect(deltaView({ delta: null, deltaNote: "conjunto distinto" })).toMatchObject({
      kind: "note",
      label: "conjunto distinto",
    });
    expect(deltaView({ delta: 0, deltaNote: null })).toBeNull();
    expect(deltaView({ delta: null, deltaNote: null })).toBeNull();
  });
});

describe("qué cambió", () => {
  it("no disponible por motivo", () => {
    const a = summarizeDiff({ available: false, reason: "no_snapshot", runId: "r2", againstId: null });
    const b = summarizeDiff({ available: false, reason: "no_previous", runId: "r2", againstId: null });
    expect(a.available).toBe(false);
    if (!a.available && !b.available) {
      expect(a.message).toMatch(/antes/);
      expect(b.message).toMatch(/anterior/);
      expect(a.message).not.toBe(b.message);
    }
  });

  it("perfil por campo, ± KB, personas y modelo", () => {
    const diff: LabRunDiffDto = {
      available: true,
      runId: "r2",
      againstId: "r1",
      profile: { tone: { before: "Cálido", after: "Cálido\nSin presión" } },
      kb: {
        added: [
          {
            id: "kb1",
            kind: "qa",
            question: "¿Tienen garantía extendida?",
            answer: "Sí, 2 años",
            content: null,
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        removed: [],
        edited: [{ id: "kb2", before: null, after: null }],
      },
      personas: { added: ["garantia"], removed: ["pide_humano", "fuera_de_kb"], edited: [] },
      models: { agent: { before: "a", after: "b" }, judge: null },
    };
    const s = summarizeDiff(diff);
    expect(s.available).toBe(true);
    if (!s.available) return;
    expect(s.headline).toEqual([
      "+1 entrada de conocimiento",
      "1 entrada editada",
      "Tono cambió",
      "+1 persona",
      "−2 personas",
      "Modelo del agente cambió",
    ]);
    expect(s.kb.added).toEqual(["¿Tienen garantía extendida?"]);
    expect(s.kb.edited[0]?.before).toMatch(/sin texto/);
    expect(s.profile).toEqual([
      { field: "tone", label: "Tono", before: "Cálido", after: "Cálido\nSin presión" },
    ]);
    expect(s.empty).toBe(false);
  });

  it("etiqueta de entradas y URL con against", () => {
    expect(kbEntryLabel({ id: "x", kind: "block", hash: "h", updatedAt: "" })).toMatch(/sin texto/);
    expect(
      kbEntryLabel({ id: "x", kind: "block", question: null, answer: null, content: "a".repeat(300), updatedAt: "" })
    ).toHaveLength(120);
    expect(diffUrl("r2", "r1")).toBe("/api/lab/runs/r2/diff?against=r1");
    expect(diffUrl("r2", null)).toBe("/api/lab/runs/r2/diff");
  });
});

describe("tendencias", () => {
  it("una fila por corrida, columnas = unión de personas", () => {
    const dto: LabTrendsDto = {
      runs: [
        {
          id: "r2",
          startedAt: "2026-10-02T00:00:00.000Z",
          finishedAt: null,
          score: 100,
          personaKeys: ["garantia", "fuera_de_kb"],
          hallazgosPorTipo: { alucinacion: 0, fuera_de_kb: 0, debio_escalar: 0, tono: 0 },
          veredictos: { garantia: "verde", fuera_de_kb: "sin_veredicto" },
        },
        {
          id: "r1",
          startedAt: "2026-10-01T00:00:00.000Z",
          finishedAt: null,
          score: 50,
          personaKeys: null,
          hallazgosPorTipo: { alucinacion: 1, fuera_de_kb: 3, debio_escalar: 0, tono: 2 },
          veredictos: { fuera_de_kb: "rojo", pide_humano: "verde" },
        },
      ],
    };
    const t = buildTrendsTable(dto);
    expect(t.personaKeys).toEqual(["garantia", "fuera_de_kb", "pide_humano"]);
    expect(t.maxCount).toBe(3);
    expect(t.rows[0]?.veredictos).toEqual({
      garantia: "verde",
      fuera_de_kb: "sin_veredicto",
      pide_humano: null,
    });
    expect(t.rows[1]?.total).toBe(6);
    expect(buildTrendsTable({ runs: [] })).toMatchObject({ rows: [], maxCount: 1, personaKeys: [] });
  });

  it("ancho de barra proporcional", () => {
    expect(barWidth(0, 3)).toBe(0);
    expect(barWidth(3, 3)).toBe(100);
    expect(barWidth(1, 3)).toBe(33);
    expect(barWidth(5, 0)).toBe(0);
  });
});
