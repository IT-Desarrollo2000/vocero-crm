import { describe, expect, it, vi } from "vitest";

/**
 * 08 — Juez simulado (ai-mock) con el prompt real del juez: el set de autos
 * da 6 verdes + 1 rojo ≈ 86 (tests/e2e/us4-lab.md), despacha por la CLAVE de
 * la persona (no por el texto) y la persona `[e2e-tono]` devuelve un
 * `ajuste` determinista hasta que el comportamiento ya lo trae.
 */

vi.mock("@/lib/ai", () => ({ chatJson: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import { buildJudgePrompt } from "@/server/ai/prompts";
import {
  AI_MOCK_KB_PREGUNTA,
  AI_MOCK_TONE_AJUSTE,
  AI_MOCK_TONE_MARKER,
  aiMockCompletion,
} from "@/server/dev/ai-mock";
import { Verdict, computeScore } from "@/server/lab/judge";
import { PERSONAS, PERSONAS_NEUTRO, fromCodePersona } from "@/server/lab/personas";

function judge(input: {
  key: string;
  name?: string;
  objetivo?: string;
  criteriosExito?: string | null;
  kbText?: string;
  behaviorText?: string;
}) {
  const { system, user } = buildJudgePrompt({
    persona: input.key,
    personaDetail: {
      name: input.name ?? input.key,
      objetivo: input.objetivo ?? "",
      rasgos: null,
      criteriosExito: input.criteriosExito ?? null,
    },
    transcript: [
      { role: "cliente", text: "Hola" },
      { role: "agente", text: "Respuesta de prueba sobre: Hola" },
    ],
    kbText: input.kbText ?? "(knowledge base vacío)",
    behaviorText: input.behaviorText ?? "Nombre: Sofi",
  });
  const raw = aiMockCompletion([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  return Verdict.parse(JSON.parse(raw));
}

const scoreOf = (verdicts: { veredicto: string }[]) =>
  computeScore(verdicts.map((v) => ({ status: "done", veredicto: v.veredicto })));

describe("ai-mock del juez", () => {
  it("set de autos (7) sin garantías en el KB → 6 verdes + 1 rojo = 86; con la sugerencia aplicada → 100", () => {
    const run = (kbText?: string) =>
      PERSONAS.map(fromCodePersona).map((p) =>
        judge({ key: p.key, name: p.name, objetivo: p.objetivo, kbText })
      );
    const first = run();
    expect(first.filter((v) => v.veredicto === "rojo")).toHaveLength(1);
    expect(scoreOf(first)).toBe(86);
    expect(first[3]!.hallazgos[0]).toMatchObject({ tipo: "fuera_de_kb", sugerencia: expect.any(Object) });
    expect(scoreOf(run("P: ¿Cuál es la política de garantías?\nR: 30 días"))).toBe(100);
  });

  it("set neutro: mismo resultado (el objetivo de fuera_de_kb menciona garantías pero no es el KB)", () => {
    const verdicts = PERSONAS_NEUTRO.map(fromCodePersona).map((p) =>
      judge({ key: p.key, name: p.name, objetivo: p.objetivo })
    );
    expect(scoreOf(verdicts)).toBe(86);
  });

  it("despacha por la clave exacta: 'fuera_de_kb' en el texto de otra persona o fuera_de_kb_2 → verde", () => {
    expect(
      judge({ key: "garantia", objetivo: "Igual que fuera_de_kb", criteriosExito: "fuera_de_kb" }).veredicto
    ).toBe("verde");
    expect(judge({ key: "fuera_de_kb_2" }).veredicto).toBe("verde");
    expect(judge({ key: "fuera_de_kb" }).veredicto).toBe("rojo");
  });

  it("[e2e-tono]: amarillo con ajuste de tono + sugerencia; con el ajuste ya en el comportamiento → verde", () => {
    const v = judge({ key: "garantia_e2e", objetivo: `Probar el tono ${AI_MOCK_TONE_MARKER}` });
    expect(v.veredicto).toBe("amarillo");
    expect(v.hallazgos[0]).toEqual({
      tipo: "tono",
      evidencia: expect.any(String),
      ajuste: { campo: "tone", texto: AI_MOCK_TONE_AJUSTE },
    });
    expect(v.hallazgos[1]?.sugerencia?.pregunta).toBe(AI_MOCK_KB_PREGUNTA);
    // La sugerencia del E2E no toca garantías: no altera el rojo de us4.
    expect(/garant|devoluc/i.test(AI_MOCK_KB_PREGUNTA)).toBe(false);

    const after = judge({
      key: "garantia_e2e",
      objetivo: `Probar el tono ${AI_MOCK_TONE_MARKER}`,
      behaviorText: `Nombre: Sofi\nTono: Amable\n${AI_MOCK_TONE_AJUSTE}`,
    });
    expect(after).toEqual({ veredicto: "verde", hallazgos: [] });
  });

  it("030 — el bloque RESULTADO (con o sin pase) no cambia el despacho del mock", () => {
    const withHandoff = (key: string, handoff: { reason: string; note: string | null } | null) => {
      const { system, user } = buildJudgePrompt({
        persona: key,
        personaDetail: { name: key, objetivo: "" },
        transcript: [{ role: "cliente", text: "Hola" }],
        kbText: "(knowledge base vacío)",
        behaviorText: "Nombre: Sofi",
        handoff,
      });
      return Verdict.parse(
        JSON.parse(aiMockCompletion([
          { role: "system", content: system },
          { role: "user", content: user },
        ]))
      ).veredicto;
    };
    expect(withHandoff("fuera_de_kb", { reason: "error", note: "garantía" })).toBe("rojo");
    expect(withHandoff("pide_humano", { reason: "cliente", note: null })).toBe("verde");
    expect(withHandoff("pide_humano", null)).toBe("verde");
  });
});
