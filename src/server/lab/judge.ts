import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { LAB_AJUSTE_CAMPOS, LAB_HALLAZGO_TIPOS } from "@/lib/lab";
import { buildJudgePrompt, type JudgePersona } from "@/server/ai/prompts";

/**
 * Normaliza un token de enum que el modelo escribió "casi bien":
 * `"debió_escalar"` → `"debio_escalar"`, `"Fuera de KB"` → `"fuera_de_kb"`,
 * `"Verde"` → `"verde"`. Lo que no es string pasa intacto (el enum lo rechaza).
 */
function normalizeToken(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Un hallazgo del juez. Tolerancia (corrección tras prueba con modelo real,
 * 08): los campos opcionales que llegan como `null`, `{}` o incompletos se
 * degradan a `undefined` sin invalidar el hallazgo; `evidencia` ausente → "".
 * El `tipo` NO tiene valor por defecto: inventarlo sería fabricar un hallazgo.
 */
const Hallazgo = z.object({
  tipo: z.preprocess(normalizeToken, z.enum(LAB_HALLAZGO_TIPOS)),
  evidencia: z.string().catch(""),
  sugerencia: z
    .object({
      pregunta: z.string().trim().min(1),
      respuesta: z.string().trim().min(1),
    })
    .optional()
    .catch(undefined),
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
});

/**
 * Veredicto estructurado del juez (FR-032, contrato ai.md).
 *
 * El `veredicto` es lo único imprescindible (alimenta el score): si falta o no
 * es reconocible, la salida es inválida y chatJson reintenta. Un hallazgo
 * irrecuperable (tipo desconocido) se DESCARTA en lugar de tumbar el veredicto
 * entero: perder un hallazgo es mejor que sacar el caso del score como
 * judge_failed sin que se note.
 */
export const Verdict = z.object({
  veredicto: z.preprocess(normalizeToken, z.enum(["verde", "amarillo", "rojo"])),
  hallazgos: z
    .array(Hallazgo.nullable().catch(null))
    .transform((items) =>
      items.filter((h): h is z.infer<typeof Hallazgo> => h !== null)
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
