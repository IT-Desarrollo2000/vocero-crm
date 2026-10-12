import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import { FICHA_TEMPLATE_AUTOS_ELECTRICOS } from "@/lib/ficha-fields";
import { agentActionSchema } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { aiMockCompletion } from "@/server/dev/ai-mock";
import { computeFichaCheck } from "@/server/lab/ficha-check";
import { PERSONAS } from "@/server/lab/personas";

/**
 * 04 — Chequeo determinista de la ficha en el Laboratorio y ramas de ficha
 * del ai-mock (las usa el E2E `scripts/e2e-ficha-agente.mjs`).
 */

const FIELDS = [...FICHA_TEMPLATE_AUTOS_ELECTRICOS];
const comprador = PERSONAS.find((p) => p.key === "comprador_decidido")!;

describe("computeFichaCheck", () => {
  it("comprador_decidido con la plantilla: esperados, llenados y cumplidos", () => {
    const r = computeFichaCheck({
      expect: comprador.expectFicha,
      fields: FIELDS,
      ficha: { modelo_interes: "Leapmotor T03", ciudad: "Mérida", extra: { x: 1 } },
    });
    expect(r).toEqual({
      esperados: ["modelo_interes", "ciudad"],
      llenados: { modelo_interes: "Leapmotor T03", ciudad: "Mérida" },
      cumplidos: ["modelo_interes"],
    });
  });

  it("sin definición o sin expectativas → null (no aplica)", () => {
    expect(computeFichaCheck({ expect: comprador.expectFicha, fields: null, ficha: {} })).toBeNull();
    expect(computeFichaCheck({ expect: undefined, fields: FIELDS, ficha: {} })).toBeNull();
  });

  it("claves esperadas que la organización no define (o no llena el agente) no cuentan", () => {
    const fields = FIELDS.map((f) => (f.key === "ciudad" ? { ...f, agentFills: false } : f));
    const r = computeFichaCheck({ expect: comprador.expectFicha, fields, ficha: {} });
    expect(r?.esperados).toEqual(["modelo_interes"]);
  });
});

describe("ai-mock — ramas de ficha", () => {
  const system = (fields: typeof FIELDS | null) =>
    buildAgentSystemPrompt({
      profile: { name: "Sofi", tone: null, instructions: null, escalationRules: null, greeting: null } as never,
      kb: [],
      stages: [{ name: "Interesado" }],
      fichaFields: fields,
    });
  const ask = (sys: string, text: string) =>
    JSON.parse(
      aiMockCompletion([
        { role: "system", content: sys },
        { role: "user", content: text },
      ])
    );

  it("con campos: modelo + ciudad viajan en `ficha` junto al reply", () => {
    const out = ask(system(FIELDS), "me interesa el T03, soy de Villahermosa");
    expect(out).toMatchObject({
      action: "reply",
      ficha: { modelo_interes: "T03", ciudad: "Villahermosa" },
    });
    expect(agentActionSchema(false).safeParse(out).success).toBe(true);
  });

  it("sin campos: el eco de siempre, sin ficha", () => {
    const out = ask(system(null), "me interesa el T03, soy de Villahermosa");
    expect(out.ficha).toBeUndefined();
    expect(out.text).toContain("Respuesta de prueba sobre");
  });

  it("la intención de compra sigue ganando (move_stage)", () => {
    const out = ask(system(FIELDS), "Me convence, quiero comprar el T03");
    expect(out.action).toBe("move_stage");
  });

  it("ficha-rota y ficha-update", () => {
    const rota = agentActionSchema(false).safeParse(ask(system(FIELDS), "ficha-rota"));
    expect(rota.success && rota.data).toEqual({ action: "reply", text: "ok" });
    const upd = agentActionSchema(false).safeParse(ask(system(null), "ficha-update"));
    expect(upd.success && upd.data).toEqual({
      action: "reply",
      text: "Anotado",
      ficha: { presupuesto: "350 mil" },
    });
  });
});
