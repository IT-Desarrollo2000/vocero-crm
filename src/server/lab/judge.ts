import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { LAB_AJUSTE_CAMPOS } from "@/lib/lab";
import { buildJudgePrompt, type JudgePersona } from "@/server/ai/prompts";

/** Veredicto estructurado del juez (FR-032, contrato ai.md). */
export const Verdict = z.object({
  veredicto: z.enum(["verde", "amarillo", "rojo"]),
  hallazgos: z.array(
    z.object({
      tipo: z.enum(["alucinacion", "fuera_de_kb", "debio_escalar", "tono"]),
      evidencia: z.string(),
      sugerencia: z
        .object({ pregunta: z.string(), respuesta: z.string() })
        .optional(),
      /**
       * 08 — Ajuste opcional del perfil (RF-08-11). Inválido → se descarta
       * solo el ajuste; el hallazgo y el veredicto se conservan.
       */
      ajuste: z
        .object({
          campo: z.enum(LAB_AJUSTE_CAMPOS),
          texto: z.string().trim().min(1),
        })
        .optional()
        .catch(undefined),
    })
  ),
});

export type VerdictType = z.infer<typeof Verdict>;

export type JudgeOutcome =
  | { status: "done"; verdict: VerdictType }
  | { status: "judge_failed"; detail: string };

/**
 * UNA llamada del juez por conversación. Los reintentos viven dentro de
 * chatJson; si aun así la salida es inválida, el caso queda judge_failed —
 * visible en el reporte y excluido del score. La corrida continúa.
 */
export async function judgeCase(input: {
  personaKey: string;
  /** 03 — Descripción de la persona: el juez sabe qué se esperaba. */
  personaDescription?: string;
  /** 03 — Semilla de ficha/notas que el agente tenía del cliente. */
  seedText?: string;
  /** 08 — Persona de BD: nombre, objetivo, rasgos y criterios de éxito. */
  persona?: JudgePersona;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): Promise<JudgeOutcome> {
  const { system, user } = buildJudgePrompt({
    persona: input.personaKey,
    personaDescription: input.personaDescription,
    personaDetail: input.persona,
    seedText: input.seedText,
    transcript: input.transcript,
    kbText: input.kbText,
    behaviorText: input.behaviorText,
  });
  const result = await chatJson(
    Verdict,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { judge: true }
  );
  if (!result.ok) {
    // Diagnóstico operativo: el caso queda visible como judge_failed y aquí
    // queda el porqué (incluye el raw= truncado del proveedor).
    console.error(
      `[lab] juez falló para ${input.personaKey}: ${result.error} — ${result.detail}`
    );
    return { status: "judge_failed", detail: result.detail };
  }
  return { status: "done", verdict: result.data };
}

/**
 * Score 0-100: % ponderado de conversaciones verdes (FR-033).
 * verde = 1 · amarillo = 0.5 · rojo = 0. judge_failed fuera del denominador.
 */
export function computeScore(
  cases: { status: string; veredicto: string | null }[]
): number | null {
  const judged = cases.filter(
    (c) => c.status === "done" && c.veredicto !== null
  );
  if (judged.length === 0) return null;
  const points = judged.reduce((acc, c) => {
    if (c.veredicto === "verde") return acc + 1;
    if (c.veredicto === "amarillo") return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((100 * points) / judged.length);
}
