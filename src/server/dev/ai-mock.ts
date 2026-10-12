import { FICHA_FIELDS_MARKER, JUDGE_MARKER } from "@/server/ai/prompts";
import { CONTEXT_CLOSE, CONTEXT_OPEN } from "@/server/ai/contact-context";

const MOCK_MODELS = /\b(t03|macaron|bingo(?: plus)?|nammi(?: 01)?)\b/i;
const MOCK_CITY =
  /\b(?:soy de|vivo en|aqu[ií] en)\s+([A-Za-zÁÉÍÓÚÑáéíóúñü]+)/i;

/** 04 — Lo que el mock "descubre" del mensaje del cliente para la ficha. */
function mockFichaFrom(message: string): Record<string, string> {
  const ficha: Record<string, string> = {};
  const model = MOCK_MODELS.exec(message)?.[1];
  if (model) ficha.modelo_interes = model.length <= 3 ? model.toUpperCase() : model;
  const city = MOCK_CITY.exec(message)?.[1];
  if (city) ficha.ciudad = city;
  return ficha;
}

/** Contenido entre los delimitadores del bloque de contexto, en una línea. */
function contextBlockOf(system: string): string | null {
  const start = system.indexOf(CONTEXT_OPEN);
  const end = system.indexOf(CONTEXT_CLOSE);
  if (start === -1 || end <= start) return null;
  return system
    .slice(start + CONTEXT_OPEN.length, end)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Proveedor LLM determinista para el self-test (contrato mocks.md).
 * Despacha por contenido del último mensaje `user` (o del system si es el
 * juez). JAMÁS es fallback en runtime: solo responde si OPENROUTER_BASE_URL
 * apunta explícitamente a él y el gate de mocks está activo.
 */

type InMessage = { role: string; content: string };

export function aiMockCompletion(messages: InMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Juez del Laboratorio: veredicto determinista por persona. Para cerrar el
  // loop del self-test, la persona fuera_de_kb pasa a verde si el CONOCIMIENTO
  // configurado ya cubre garantías/devoluciones (sugerencia aplicada).
  if (system.includes(JUDGE_MARKER)) {
    const kbSection =
      lastUser
        .split("CONOCIMIENTO CONFIGURADO:")[1]
        ?.split("TRANSCRIPT COMPLETO:")[0] ?? "";
    const kbCoversWarranty = /garant|devoluc/i.test(kbSection);
    if (lastUser.includes("fuera_de_kb") && !kbCoversWarranty) {
      return JSON.stringify({
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            evidencia:
              "El cliente preguntó por garantías y devoluciones y el conocimiento no lo cubre.",
            sugerencia: {
              pregunta: "¿Cuál es la política de garantías y devoluciones?",
              respuesta:
                "Aceptamos devoluciones dentro de los 30 días con ticket de compra; la garantía depende del fabricante.",
            },
          },
        ],
      });
    }
    return JSON.stringify({ veredicto: "verde", hallazgos: [] });
  }

  const text = lastUser.toLowerCase();

  // 03 — "¿qué sabes de mí?": devuelve el bloque DATOS DEL CONTACTO que llegó
  // en el system, en una línea. Prueba que el bloque LLEGA (inyección), no la
  // calidad de la respuesta.
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (plain.includes("que sabes de mi")) {
    return JSON.stringify({
      action: "reply",
      text: `CTX: ${contextBlockOf(system) ?? "(sin datos del contacto)"}`,
    });
  }

  // Persona pide_humano (el regex de respaldo captura la frase canónica; esta
  // rama cubre variantes que llegan al modelo).
  if (text.includes("humano") || text.includes("asesor")) {
    return JSON.stringify({ action: "handoff", reason: "cliente" });
  }

  // Intención de compra → mover a Interesado.
  if (
    text.includes("lo compro") ||
    text.includes("quiero comprar") ||
    text.includes("me lo llevo")
  ) {
    return JSON.stringify({
      action: "move_stage",
      stage: "Interesado",
      reply: "¡Excelente! Te aparto el producto y un compañero te confirma el pago.",
    });
  }

  // 04 — Ficha. Palabras clave de prueba (sin depender de la definición):
  // "ficha-rota" manda una ficha que no es objeto (el cliente debe recibir su
  // respuesta igual) y "ficha-update" usa el alias `update_ficha` con un
  // presupuesto en texto (la puerta lo convierte a número).
  if (text.includes("ficha-rota")) {
    return JSON.stringify({ action: "reply", text: "ok", ficha: "no soy un objeto" });
  }
  if (text.includes("ficha-update")) {
    return JSON.stringify({
      action: "update_ficha",
      reply: "Anotado",
      ficha: { presupuesto: "350 mil" },
    });
  }
  // Con la sección de campos en el prompt, un modelo conocido o la ciudad del
  // cliente viajan en `ficha` junto a la respuesta (D-04-1).
  if (system.includes(FICHA_FIELDS_MARKER)) {
    const ficha = mockFichaFrom(lastUser);
    if (Object.keys(ficha).length > 0) {
      return JSON.stringify({
        action: "reply",
        text: ficha.modelo_interes
          ? `¡Anotado! Con gusto te cuento del ${ficha.modelo_interes}.`
          : "¡Gracias! Lo tomo en cuenta.",
        ficha,
      });
    }
  }

  const eco = lastUser.slice(0, 80);
  return JSON.stringify({
    action: "reply",
    text: `Respuesta de prueba sobre: ${eco}`,
  });
}
