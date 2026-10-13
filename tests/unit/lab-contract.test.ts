import { describe, expect, it, vi } from "vitest";

/**
 * 08 — Contrato 08-0 del Laboratorio por cliente: piezas puras que fijan la
 * forma de los datos para 08-A (servidor) y 08-B (UI).
 */

vi.mock("@/lib/ai", () => ({ chatJson: vi.fn() }));

import { LAB_MAX_PERSONAS_PER_RUN } from "@/lib/lab";
import { buildJudgePrompt } from "@/server/ai/prompts";
import { samePersonaSet } from "@/server/lab/history";
import { Verdict } from "@/server/lab/judge";
import {
  PERSONAS,
  PERSONAS_AUTOS,
  PERSONAS_NEUTRO,
  chooseSeedSet,
  compileExpectFicha,
  fromCodePersona,
  isSyntheticLabPhone,
  legacyPersonaLabel,
  personaSnapshot,
  seedPersonas,
  serializeExpectFicha,
  syntheticLabPhone,
} from "@/server/lab/personas";
import { runTimeoutMsFor } from "@/server/lab/runner";
import {
  parseTrendsLimit,
  personaCreateSchema,
  personaPatchSchema,
  runCreateSchema,
} from "@/server/lab/schemas";

describe("teléfono sintético", () => {
  it("prefijo 52100000 + 5 dígitos", () => {
    expect(syntheticLabPhone(1)).toBe("5210000000001");
    expect(syntheticLabPhone(42)).toBe("5210000000042");
    expect(isSyntheticLabPhone("5210000000099")).toBe(true);
    expect(isSyntheticLabPhone("5219991234567")).toBe(false);
    expect(isSyntheticLabPhone("52100000000011")).toBe(false);
    expect(isSyntheticLabPhone(null)).toBe(false);
    expect(() => syntheticLabPhone(0)).toThrow();
  });

  it("todas las personas de semilla tienen teléfono sintético", () => {
    for (const p of [...PERSONAS_AUTOS, ...PERSONAS_NEUTRO]) {
      expect(isSyntheticLabPhone(p.phone), p.key).toBe(true);
    }
  });
});

describe("sets de semilla (D-08-01)", () => {
  it("autos = las 7 de siempre; neutro con las MISMAS claves y teléfonos", () => {
    expect(PERSONAS_AUTOS).toBe(PERSONAS);
    expect(PERSONAS_AUTOS).toHaveLength(7);
    expect(PERSONAS_NEUTRO.map((p) => [p.key, p.phone])).toEqual(
      PERSONAS_AUTOS.map((p) => [p.key, p.phone])
    );
    expect(PERSONAS_NEUTRO.some((p) => /t03|leapmotor|bingo|macaron/i.test(p.script.join(" ")))).toBe(false);
  });

  it("orgs con corridas → autos; nuevas → neutro", () => {
    expect(chooseSeedSet(true)).toBe("autos");
    expect(chooseSeedSet(false)).toBe("neutro");
    expect(seedPersonas("autos")).toBe(PERSONAS_AUTOS);
    expect(seedPersonas("neutro")).toBe(PERSONAS_NEUTRO);
  });

  it("guiones dentro de los límites (1..8 × 1..500)", () => {
    for (const p of [...PERSONAS_AUTOS, ...PERSONAS_NEUTRO]) {
      expect(p.script.length).toBeGreaterThanOrEqual(1);
      expect(p.script.length).toBeLessThanOrEqual(8);
      for (const line of p.script) expect(line.length).toBeLessThanOrEqual(500);
    }
  });

  it("etiqueta de respaldo para corridas anteriores a 08", () => {
    expect(legacyPersonaLabel("fuera_de_kb")).toBe("Pregunta fuera del conocimiento");
    expect(legacyPersonaLabel("inventada")).toBe("inventada");
  });
});

describe("expectFicha en jsonb", () => {
  it("ida y vuelta RegExp ↔ reglas; una regla inválida se descarta", () => {
    const rules = serializeExpectFicha({ modelo_interes: /t03/i });
    expect(rules).toEqual([{ key: "modelo_interes", pattern: "t03", flags: "i" }]);
    const compiled = compileExpectFicha([...rules, { key: "x", pattern: "(", flags: "" }]);
    expect(Object.keys(compiled ?? {})).toEqual(["modelo_interes"]);
    expect(compiled?.modelo_interes?.test("Leapmotor T03")).toBe(true);
    expect(compileExpectFicha([])).toBeUndefined();
  });
});

describe("personaSnapshot", () => {
  it("copia la persona y su hash cambia solo si cambia lo evaluado", () => {
    const base = fromCodePersona(PERSONAS[0]!);
    const snap = personaSnapshot(base);
    expect(snap).toMatchObject({
      id: null,
      key: "comprador_decidido",
      name: "Comprador decidido",
      guion: PERSONAS[0]!.script,
      expectFicha: serializeExpectFicha(PERSONAS[0]!.expectFicha),
    });
    expect(personaSnapshot({ ...base, position: 9 }).hash).toBe(snap.hash);
    expect(personaSnapshot({ ...base, guion: ["Hola"] }).hash).not.toBe(snap.hash);
    expect(personaSnapshot({ ...base, criteriosExito: "escalar" }).hash).not.toBe(snap.hash);
  });
});

describe("delta comparable (RF-08-17)", () => {
  it("mismas claves en cualquier orden; hash distinto o claves distintas → no", () => {
    expect(samePersonaSet({ personaKeys: ["a", "b"] }, { personaKeys: ["b", "a"] })).toBe(true);
    expect(samePersonaSet({ personaKeys: ["a"] }, { personaKeys: ["a", "b"] })).toBe(false);
    expect(
      samePersonaSet(
        { personaKeys: ["a"], personaHashes: [{ key: "a", hash: "1" }] },
        { personaKeys: ["a"], personaHashes: [{ key: "a", hash: "2" }] }
      )
    ).toBe(false);
  });

  it("corridas anteriores a 08 solo se comparan entre sí", () => {
    expect(samePersonaSet({ personaKeys: null }, { personaKeys: null })).toBe(true);
    expect(samePersonaSet({ personaKeys: null }, { personaKeys: ["a"] })).toBe(false);
  });
});

describe("juez (RF-08-08, RF-08-11)", () => {
  it("Verdict sin ajuste sigue válido; ajuste válido se conserva; inválido se descarta solo", () => {
    expect(Verdict.safeParse({ veredicto: "verde", hallazgos: [] }).success).toBe(true);
    const ok = Verdict.parse({
      veredicto: "amarillo",
      hallazgos: [{ tipo: "tono", evidencia: "x", ajuste: { campo: "tone", texto: "Más cálido" } }],
    });
    expect(ok.hallazgos[0]?.ajuste).toEqual({ campo: "tone", texto: "Más cálido" });
    const bad = Verdict.parse({
      veredicto: "amarillo",
      hallazgos: [{ tipo: "tono", evidencia: "x", ajuste: { campo: "greeting", texto: "x" } }],
    });
    expect(bad.hallazgos).toHaveLength(1);
    expect(bad.hallazgos[0]?.ajuste).toBeUndefined();
  });

  it("con persona de BD: línea key — nombre, criterios, y los encabezados del ai-mock intactos", () => {
    const { user } = buildJudgePrompt({
      persona: "fuera_de_kb",
      personaDetail: {
        name: "Pregunta fuera del conocimiento",
        objetivo: "No inventar",
        rasgos: "Insistente",
        criteriosExito: "Debe escalar a la segunda",
      },
      transcript: [{ role: "cliente", text: "Hola" }],
      kbText: "P: horario",
      behaviorText: "",
    });
    expect(user.startsWith("PERSONA SIMULADA: fuera_de_kb — Pregunta fuera del conocimiento\n")).toBe(true);
    expect(user).toContain("Debe escalar a la segunda");
    expect(user).toContain("Insistente");
    const kb = user.split("CONOCIMIENTO CONFIGURADO:")[1]?.split("TRANSCRIPT COMPLETO:")[0];
    expect(kb?.trim()).toBe("P: horario");
  });

  it("sin persona de BD: idéntico a hoy", () => {
    const { user } = buildJudgePrompt({
      persona: "pide_humano",
      personaDescription: "Pide una persona",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    expect(user.split("\n")[0]).toBe("PERSONA SIMULADA: pide_humano — Pide una persona");
    expect(user).not.toContain("CRITERIOS DE ÉXITO");
  });
});

describe("timeout escalado (D-08-03)", () => {
  it("LAB_RUN_TIMEOUT_MS manda; si no, max(10 min, casos × (msgs × 15 s + 30 s))", () => {
    expect(runTimeoutMsFor("5000", { cases: 10, maxMessages: 8 })).toBe(5000);
    expect(runTimeoutMsFor(undefined, { cases: 1, maxMessages: 1 })).toBe(600_000);
    expect(runTimeoutMsFor(undefined, { cases: 7, maxMessages: 5 })).toBe(735_000);
    expect(runTimeoutMsFor("abc", { cases: 10, maxMessages: 8 })).toBe(1_500_000);
  });
});

describe("validación de entrada", () => {
  it("POST /api/lab/runs: 1..10 claves únicas, cuerpo vacío válido", () => {
    expect(runCreateSchema.safeParse({}).success).toBe(true);
    expect(runCreateSchema.safeParse({ personaKeys: [] }).success).toBe(false);
    expect(runCreateSchema.safeParse({ personaKeys: ["a", "a"] }).success).toBe(false);
    const eleven = Array.from({ length: LAB_MAX_PERSONAS_PER_RUN + 1 }, (_, i) => `p${i}`);
    expect(runCreateSchema.safeParse({ personaKeys: eleven }).success).toBe(false);
  });

  it("crear persona: key y phone del cliente se descartan; guion de 9 → inválido", () => {
    const parsed = personaCreateSchema.parse({
      name: "Garantía extendida",
      guion: ["Hola"],
      key: "hack",
      phone: "5219991234567",
    });
    expect(parsed).not.toHaveProperty("key");
    expect(parsed).not.toHaveProperty("phone");
    expect(
      personaCreateSchema.safeParse({ name: "x", guion: Array(9).fill("hola") }).success
    ).toBe(false);
    expect(personaCreateSchema.safeParse({ name: "x", guion: ["a".repeat(501)] }).success).toBe(false);
  });

  it("PATCH vacío → inválido", () => {
    expect(personaPatchSchema.safeParse({}).success).toBe(false);
    expect(personaPatchSchema.safeParse({ active: false }).success).toBe(true);
  });

  it("limit de la tendencia", () => {
    expect(parseTrendsLimit(null)).toBe(10);
    expect(parseTrendsLimit("3")).toBe(3);
    expect(parseTrendsLimit("999")).toBe(50);
    expect(parseTrendsLimit("-1")).toBe(10);
  });
});
