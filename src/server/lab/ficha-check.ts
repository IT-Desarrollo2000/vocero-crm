import type { FichaCheck, FichaFieldDef } from "@/lib/ficha-fields";
import type { FichaValue } from "@/lib/types";

/**
 * 04 — Verificación de llenado de la ficha por persona del Laboratorio
 * (`agent_test_case.ficha_check`). Determinista e informativa: NO la decide
 * el juez ni entra al score.
 *
 * Solo cuentan las claves esperadas que la organización tiene definidas y que
 * llena el agente: sin definición (o sin ninguna clave aplicable) no hay
 * nada que verificar y devuelve `null`.
 */
export function computeFichaCheck(input: {
  expect: Record<string, RegExp> | undefined;
  fields: readonly FichaFieldDef[] | null | undefined;
  ficha: Record<string, unknown> | null | undefined;
}): FichaCheck | null {
  if (!input.expect || !input.fields?.length) return null;
  const fillable = new Set(
    input.fields.filter((f) => f.agentFills).map((f) => f.key)
  );
  const esperados = Object.keys(input.expect).filter((k) => fillable.has(k));
  if (esperados.length === 0) return null;

  const llenados: Record<string, FichaValue> = {};
  for (const [k, v] of Object.entries(input.ficha ?? {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      llenados[k] = v;
    }
  }
  const cumplidos = esperados.filter((k) => {
    const v = llenados[k];
    const re = input.expect?.[k];
    return v !== undefined && !!re && re.test(String(v));
  });
  return { esperados, llenados, cumplidos };
}
