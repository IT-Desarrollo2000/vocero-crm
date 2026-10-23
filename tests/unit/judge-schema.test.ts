import { describe, expect, it } from "vitest";
import { extractJson } from "@/lib/ai";
import { buildJudgePrompt, JUDGE_MARKER } from "@/server/ai/prompts";
import { Verdict } from "@/server/lab/judge";

/**
 * Corrección tras prueba con modelo real (08): un modelo de razonamiento
 * devolvía `sugerencia: null`/`{}`, `tipo` con tilde y `<think>` antes del
 * JSON; el esquema rechazaba el veredicto entero y el caso salía del score
 * como judge_failed. Fixtures SINTÉTICOS con la misma FORMA.
 */

/** Mismo camino que chatJson: extracción robusta → Zod. */
function parse(raw: string) {
  const extracted = extractJson(raw);
  expect(extracted).not.toBeNull();
  return Verdict.safeParse(extracted);
}

const ajusteEscalar = {
  campo: "escalationRules",
  texto: "Si el cliente pide un humano, escala en ese mismo turno.",
};

describe("Verdict — tolerancia a la forma de un modelo de razonamiento", () => {
  it("sugerencia: null → hallazgo conservado, sugerencia omitida, ajuste intacto", () => {
    const r = Verdict.safeParse({
      veredicto: "rojo",
      hallazgos: [
        {
          tipo: "debio_escalar",
          evidencia: "CLIENTE: quiero hablar con una persona",
          sugerencia: null,
          ajuste: ajusteEscalar,
        },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.veredicto).toBe("rojo");
    expect(r.data.hallazgos).toHaveLength(1);
    expect(r.data.hallazgos[0]!.sugerencia).toBeUndefined();
    expect(r.data.hallazgos[0]!.ajuste).toEqual(ajusteEscalar);
  });

  it("sugerencia: {} y ajuste: null → ambos omitidos, hallazgo conservado", () => {
    const r = Verdict.safeParse({
      veredicto: "amarillo",
      hallazgos: [
        { tipo: "tono", evidencia: "¡Súper!", sugerencia: {}, ajuste: null },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.hallazgos[0]).toEqual({ tipo: "tono", evidencia: "¡Súper!" });
  });

  it("sugerencia incompleta o vacía → se descarta solo la sugerencia", () => {
    const r = Verdict.safeParse({
      veredicto: "amarillo",
      hallazgos: [
        {
          tipo: "fuera_de_kb",
          evidencia: "AGENTE: el envío es gratis",
          sugerencia: { pregunta: "¿El envío tiene costo?" },
        },
        {
          tipo: "fuera_de_kb",
          evidencia: "AGENTE: abrimos en feriados",
          sugerencia: { pregunta: "  ", respuesta: "Sí" },
        },
        {
          tipo: "alucinacion",
          evidencia: "AGENTE: cuesta 100",
          sugerencia: { pregunta: "¿Cuánto cuesta el plan base?", respuesta: "Ver lista de precios." },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.hallazgos.map((h) => h.sugerencia)).toEqual([
      undefined,
      undefined,
      { pregunta: "¿Cuánto cuesta el plan base?", respuesta: "Ver lista de precios." },
    ]);
  });

  it("tipo con tilde, mayúsculas o espacios → se normaliza al enum", () => {
    const r = Verdict.safeParse({
      veredicto: "Amarillo",
      hallazgos: [
        { tipo: "debió_escalar", evidencia: "a" },
        { tipo: "Fuera de KB", evidencia: "b" },
        { tipo: " ALUCINACIÓN ", evidencia: "c" },
        { tipo: "fuera-de-kb", evidencia: "d" },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.veredicto).toBe("amarillo");
    expect(r.data.hallazgos.map((h) => h.tipo)).toEqual([
      "debio_escalar",
      "fuera_de_kb",
      "alucinacion",
      "fuera_de_kb",
    ]);
  });

  it("hallazgo irrecuperable (tipo desconocido / no objeto) → se descarta; el veredicto se conserva", () => {
    const r = Verdict.safeParse({
      veredicto: "rojo",
      hallazgos: [
        { tipo: "otro", evidencia: "x" },
        null,
        "texto suelto",
        { evidencia: "sin tipo" },
        { tipo: "tono", evidencia: "válido" },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.veredicto).toBe("rojo");
    expect(r.data.hallazgos).toEqual([{ tipo: "tono", evidencia: "válido" }]);
  });

  it("evidencia ausente → \"\" (igual que readHallazgos), el tipo se conserva", () => {
    const r = Verdict.safeParse({
      veredicto: "amarillo",
      hallazgos: [{ tipo: "tono" }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.hallazgos).toEqual([{ tipo: "tono", evidencia: "" }]);
  });

  it("veredicto ausente o desconocido → inválido (chatJson reintenta)", () => {
    expect(Verdict.safeParse({ hallazgos: [] }).success).toBe(false);
    expect(Verdict.safeParse({ veredicto: "naranja", hallazgos: [] }).success).toBe(false);
    expect(Verdict.safeParse({ veredicto: null, hallazgos: [] }).success).toBe(false);
  });

  it("<think>…</think> + bloque ```json con null/{} y tipo con tilde → aceptado", () => {
    const raw = [
      "<think>",
      "El cliente pidió un humano dos veces y el agente solo ofreció pasarlo.",
      'Debo responder un objeto con "veredicto" y "hallazgos" { no esto }.',
      "</think>",
      "",
      "```json",
      JSON.stringify(
        {
          veredicto: "amarillo",
          hallazgos: [
            {
              tipo: "debió_escalar",
              evidencia: "AGENTE: ¿Le gustaría que lo pase con alguien?",
              sugerencia: {},
              ajuste: ajusteEscalar,
            },
            {
              tipo: "tono",
              evidencia: "AGENTE: ¡Genial, genial!",
              sugerencia: null,
              ajuste: null,
            },
          ],
        },
        null,
        2
      ),
      "```",
    ].join("\n");
    const r = parse(raw);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({
      veredicto: "amarillo",
      hallazgos: [
        {
          tipo: "debio_escalar",
          evidencia: "AGENTE: ¿Le gustaría que lo pase con alguien?",
          ajuste: ajusteEscalar,
        },
        { tipo: "tono", evidencia: "AGENTE: ¡Genial, genial!" },
      ],
    });
  });

  it("JSON compacto sin markdown (reintento STRICT) → aceptado", () => {
    const r = parse(
      '{"veredicto":"verde","hallazgos":[{"tipo":"tono","evidencia":"ok","sugerencia":{},"ajuste":{"campo":"desconocido","texto":"x"}}]}'
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.hallazgos).toEqual([{ tipo: "tono", evidencia: "ok" }]);
  });
});

describe("buildJudgePrompt — opcionales se omiten", () => {
  it("pide omitir la clave en vez de null/{}, sin tocar los encabezados del ai-mock", () => {
    const { system, user } = buildJudgePrompt({
      persona: "comprador_decidido",
      personaDescription: "Sabe lo que quiere",
      transcript: [{ role: "cliente", text: "hola" }],
      kbText: "kb",
      behaviorText: "b",
    });
    expect(system).toContain("Si un campo opcional no aplica, OMITE la clave; nunca uses null ni {}");
    expect(user).toContain("PERSONA SIMULADA: comprador_decidido — Sabe lo que quiere");
    expect(user).toContain("CONOCIMIENTO CONFIGURADO:");
    expect(user).toContain("TRANSCRIPT COMPLETO:");
  });
});

describe("030 — buildJudgePrompt con el RESULTADO de la conversación", () => {
  const base = {
    persona: "pide_humano",
    personaDescription: "Pide una persona",
    transcript: [{ role: "cliente" as const, text: "quiero hablar con un humano" }],
    kbText: "kb",
    behaviorText: "b",
  };

  function blockOf(user: string): string {
    return user.split("TRANSCRIPT COMPLETO:")[1] ?? "";
  }

  it("pase pedido por el cliente: motivo legible + clave, DESPUÉS del transcript", () => {
    const { system, user } = buildJudgePrompt({
      ...base,
      handoff: { reason: "cliente", note: null },
    });
    expect(blockOf(user)).toContain(
      "RESULTADO DE LA CONVERSACIÓN:\nEl sistema pasó la conversación a un asesor humano (motivo: El cliente pidió un humano [cliente])."
    );
    expect(user.indexOf("RESULTADO DE LA CONVERSACIÓN:")).toBeGreaterThan(
      user.indexOf("TRANSCRIPT COMPLETO:")
    );
    expect(user.trimEnd().endsWith("Evalúa y responde el JSON.")).toBe(true);
    // Lo que lee el ai-mock queda igual.
    expect(user.split("\n")[0]).toBe("PERSONA SIMULADA: pide_humano — Pide una persona");
    expect(system.startsWith(JUDGE_MARKER)).toBe(true);
    // Reglas nuevas en el system.
    expect(system).toContain("RESULTADO DE LA CONVERSACIÓN no muestra un pase a un asesor → debio_escalar");
    expect(system).toContain("aunque el agente no haya escrito ningún mensaje: NO es debio_escalar");
    expect(system).toContain("motivo [error] es una falla técnica del agente");
  });

  it("pase por error con nota: la nota viaja y el motivo es [error]", () => {
    const { user } = buildJudgePrompt({
      ...base,
      handoff: { reason: "error", note: "  el proveedor no respondió  " },
    });
    expect(blockOf(user)).toContain(
      "(motivo: Error del proveedor de IA [error]; nota: el proveedor no respondió)."
    );
  });

  it("motivo desconocido o ausente → crudo / «sin motivo registrado», nunca el texto del panel", () => {
    expect(
      buildJudgePrompt({ ...base, handoff: { reason: "otro", note: "" } }).user
    ).toContain("(motivo: otro [otro]).");
    const none = buildJudgePrompt({ ...base, handoff: { reason: null, note: null } }).user;
    expect(none).toContain("(motivo: sin motivo registrado).");
    expect(none).not.toContain("La IA está en pausa");
  });

  it("sin handoff (null o ausente) → la línea explícita de que no hubo pase", () => {
    for (const handoff of [null, undefined]) {
      const { user } = buildJudgePrompt({ ...base, handoff });
      expect(blockOf(user)).toContain(
        "RESULTADO DE LA CONVERSACIÓN:\nLa conversación terminó sin pase a un asesor."
      );
      expect(user).not.toContain("El sistema pasó la conversación");
    }
  });
});
