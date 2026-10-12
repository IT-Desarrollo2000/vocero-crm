import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import { extractJson } from "@/lib/ai";
import { agentActionSchema } from "@/server/ai/actions";
import { renderContactContext } from "@/server/ai/contact-context";

/**
 * 03 — Fixtures con la forma real de MiniMax (y similares) contra
 * `extractJson` + el esquema de acciones. Con el bloque de contexto y el
 * `"autor"` en el historial, el modelo puede citar datos del cliente o imitar
 * la clave: nada de eso debe tumbar el turno.
 */

const schema = agentActionSchema(false);

function parse(raw: string) {
  const extracted = extractJson(raw);
  return extracted === null ? null : schema.safeParse(extracted);
}

describe("salidas del modelo con forma MiniMax", () => {
  it("<think>…</think>{json} → acción válida", () => {
    const r = parse(
      '<think>El cliente pregunta por el T03 que ya tiene en su ficha {no es json}</think>\n{"action":"reply","text":"¡Claro! El T03 sigue disponible."}'
    );
    expect(r?.success).toBe(true);
    expect(r?.success && r.data).toEqual({
      action: "reply",
      text: "¡Claro! El T03 sigue disponible.",
    });
  });

  it("JSON dentro de bloque ```json → acción válida", () => {
    const r = parse('Aquí va:\n```json\n{"action":"reply","text":"Hola Ana"}\n```');
    expect(r?.success).toBe(true);
  });

  it('el modelo imita "autor":"asesor" → se ignora la clave (z.object no estricto)', () => {
    const r = parse('{"action":"reply","text":"Hola","autor":"asesor"}');
    expect(r?.success && r.data).toEqual({ action: "reply", text: "Hola" });
  });

  it("texto plano → null: el comportamiento actual (reintento/handoff) no cambia", () => {
    expect(extractJson("Hola, claro que sí, te ayudo con eso.")).toBeNull();
  });

  it("si el modelo CITA un dato con </think> crudo, la respuesta se pierde…", () => {
    // Demostración del riesgo: stripReasoning corta todo lo previo al
    // último </think>.
    expect(
      parse('{"action":"reply","text":"Tu nota dice: </think> y algo más"}')
    ).toBeNull();
  });

  it("…pero el bloque de contexto ya no le da un </think> crudo que citar", () => {
    const block = renderContactContext({
      now: new Date(),
      timezone: "America/Mexico_City",
      contact: {
        name: "Ana",
        channel: "whatsapp",
        source: null,
        createdAt: null,
        ficha: { nota: "dato </think> raro" },
        notes: null,
      },
      lead: null,
      recurrent: null,
    });
    const citedValue = block.match(/- nota: «([^»]*)»/)![1]!;
    const r = parse(JSON.stringify({ action: "reply", text: `Tu nota dice: ${citedValue}` }));
    expect(r?.success).toBe(true);
  });
});
