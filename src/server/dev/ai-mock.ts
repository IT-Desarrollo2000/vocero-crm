import { FICHA_FIELDS_MARKER, JUDGE_MARKER } from "@/server/ai/prompts";
import { CONTEXT_CLOSE, CONTEXT_OPEN } from "@/server/ai/contact-context";

/** 08 — Marcador que el E2E pone en el objetivo de una persona creada. */
export const AI_MOCK_TONE_MARKER = "[e2e-tono]";
/** 08 — Texto del `ajuste` de tono que propone el juez simulado. */
export const AI_MOCK_TONE_AJUSTE =
  "Cierra cada respuesta ofreciendo ayuda adicional.";
/** 08 — Pregunta de la sugerencia P/R (no toca garantías: no altera us4). */
export const AI_MOCK_KB_PREGUNTA = "¿Atienden en fin de semana?";
/** Primera línea del prompt del juez: `PERSONA SIMULADA: <key>[ — …]`. */
const JUDGE_PERSONA_LINE = /^PERSONA SIMULADA: (\S+)(?:\s|$)/;

const MOCK_MODELS =/\b(t03|macaron|bingo(?: plus)?|nammi(?: 01)?)\b/i;
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
    // 08 — Despacho por la CLAVE de la línea de la persona (exacta: no
    // `fuera_de_kb_2`), no por el texto: una persona personalizada que
    // mencione "fuera_de_kb" en su objetivo no se pinta de rojo.
    const personaKey = JUDGE_PERSONA_LINE.exec(lastUser)?.[1] ?? "";
    // 08 — Persona del E2E con `[e2e-tono]` en su objetivo: amarillo con un
    // `ajuste` de tono hasta que el COMPORTAMIENTO ya lo trae (ajuste
    // aplicado → verde). Trae además una sugerencia P/R para el KB.
    if (lastUser.includes(AI_MOCK_TONE_MARKER)) {
      const behavior =
        lastUser
          .split("COMPORTAMIENTO CONFIGURADO:")[1]
          ?.split("CONOCIMIENTO CONFIGURADO:")[0] ?? "";
      if (behavior.includes(AI_MOCK_TONE_AJUSTE)) {
        return JSON.stringify({ veredicto: "verde", hallazgos: [] });
      }
      return JSON.stringify({
        veredicto: "amarillo",
        hallazgos: [
          {
            tipo: "tono",
            evidencia: "El agente respondió seco, sin ofrecer más ayuda.",
            ajuste: { campo: "tone", texto: AI_MOCK_TONE_AJUSTE },
          },
          {
            tipo: "fuera_de_kb",
            evidencia: "El cliente preguntó por el horario de fin de semana.",
            sugerencia: {
              pregunta: AI_MOCK_KB_PREGUNTA,
              respuesta: "Sí, los sábados de 9:00 a 14:00.",
            },
          },
        ],
      });
    }
    if (personaKey === "fuera_de_kb" && !kbCoversWarranty) {
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

  // 023 — Marcadores del E2E de agenda (scripts/e2e-agenda-presencial.mjs).
  // No se dispara con "agendar": el selftest ya usa esa palabra en sus textos
  // y cambiaría sus respuestas. La reserva lleva el ISO porque las ofertas no
  // viajan en el prompt: el guion lo toma de la oferta registrada.
  const agendaTipo = /\[e2e-agenda ([^\]]+)\]/i.exec(lastUser)?.[1];
  if (agendaTipo) {
    return JSON.stringify({ action: "offer_slots", type: agendaTipo.trim() });
  }
  const reservaIso = /\[e2e-reserva (\S+?)\]/i.exec(lastUser)?.[1];
  if (reservaIso) {
    return JSON.stringify({ action: "book_slot", startUtc: reservaIso });
  }

  // 025 — Marcadores SIN ISO: el modelo simulado tiene que LEER el prompt
  // (calendario "Próximos días" y bloque HORARIOS OFRECIDOS) como uno real.
  // Miran TODOS los mensajes del cliente desde la última respuesta del
  // agente: con el coalescido llegan juntos y el último puede no ser el de la
  // hora ("15" + "¿y cuánto cuesta?").
  const agenda025 = agenda025Action(system, newUserText(messages));
  if (agenda025) return JSON.stringify(agenda025);

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

// ── 025 — Agenda sin ISO (scripts/e2e-agenda-presencial.mjs) ─────────────

/** El texto que dijo el incidente del 21-oct (horarios inventados). */
export const AI_MOCK_INVENTED_SLOTS =
  "Con gusto. ¿Cuál de estos horarios del viernes le acomoda? • viernes, 24 de octubre a las 10:00 • viernes, 24 de octubre a las 10:30 • viernes, 24 de octubre a las 11:00";
/** B1 — La respuesta al precio que viaja en el `reply` de book_slot. */
export const AI_MOCK_PRICE_REPLY = "El Macaron 2P cuesta $285,990.";
/** Un horario de atención (falso positivo de la barrera: sale tal cual). */
export const AI_MOCK_ATTENTION_HOURS =
  "Abrimos de lunes a sábado de 9:00 a 18:00 y domingo de 10:00 a 15:00.";

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Mensajes del cliente desde la última respuesta del agente, unidos. */
function newUserText(messages: InMessage[]): string {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") break;
    if (m.role === "user") out.unshift(m.content);
  }
  return out.join("\n");
}

/** Nombre de día (completo o corto, con o sin acento) → "vie", "sab"… */
const DAY_SHORT: Record<string, string> = {
  lunes: "lun",
  martes: "mar",
  miercoles: "mie",
  jueves: "jue",
  viernes: "vie",
  sabado: "sab",
  domingo: "dom",
};

/**
 * Resuelve un día LEYENDO el prompt: "YYYY-MM-DD" tal cual; "hoy" de la
 * línea "Hoy: … = YYYY-MM-DD"; un nombre de día de "Próximos días: jue
 * 22=2026-10-22, …". No calcula fechas: si el prompt no las trae, no hay día.
 */
function dayFromPrompt(system: string, raw: string): string | null {
  const t = fold(raw.trim());
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (t === "hoy") return /^Hoy:.*=\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(system)?.[1] ?? null;
  const short = DAY_SHORT[t] ?? (Object.values(DAY_SHORT).includes(t.slice(0, 3)) ? t.slice(0, 3) : null);
  if (!short) return null;
  const line = /^Próximos días:\s*(.+)$/m.exec(system)?.[1] ?? "";
  for (const item of line.split(",")) {
    const m = /^\s*(\S+)\s+\d{1,2}=(\d{4}-\d{2}-\d{2})/.exec(item);
    if (m && fold(m[1]!).slice(0, 3) === short) return m[2]!;
  }
  return null;
}

/** Líneas del bloque HORARIOS OFRECIDOS: `{ seen, key }`. */
function offeredFromPrompt(system: string): { seen: boolean; key: string }[] {
  const start = system.indexOf("HORARIOS OFRECIDOS");
  if (start === -1) return [];
  const out: { seen: boolean; key: string }[] = [];
  for (const line of system.slice(start).split("\n").slice(1)) {
    const m = /^([*-]) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\b/.exec(line);
    if (!m) break;
    out.push({ seen: m[1] === "*", key: m[2]! });
  }
  return out;
}

function agenda025Action(system: string, userText: string): Record<string, unknown> | null {
  // [e2e-dia <viernes|YYYY-MM-DD> <tipo>]
  const dia = /\[e2e-dia (\S+)\s+([^\]]+)\]/i.exec(userText);
  if (dia) {
    const date = dayFromPrompt(system, dia[1]!);
    return {
      action: "offer_slots",
      type: dia[2]!.trim(),
      ...(date ? { date } : {}),
    };
  }
  // [e2e-elige <HH:MM|H>] · [e2e-elige-con-precio <HH:MM|H>] (B1: además
  // contesta el precio en el `reply` de la misma acción).
  const elige = /\[e2e-elige(-con-precio)? (\d{1,2})(?::(\d{2}))?\]/i.exec(userText);
  if (elige) {
    const hhmm = `${elige[2]!.padStart(2, "0")}:${elige[3] ?? "00"}`;
    const reply = elige[1] ? { reply: AI_MOCK_PRICE_REPLY } : {};
    const offered = offeredFromPrompt(system);
    const hit =
      offered.find((o) => o.seen && o.key.endsWith(` ${hhmm}`)) ??
      offered.find((o) => o.key.endsWith(` ${hhmm}`));
    if (hit) return { action: "book_slot", slot: hit.key, ...reply };
    // Ninguna coincide: una clave inexistente del MISMO día (re-oferta).
    const day =
      (offered.find((o) => o.seen) ?? offered[0])?.key.slice(0, 10) ??
      /^Hoy:.*=\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(system)?.[1];
    return day
      ? { action: "book_slot", slot: `${day} ${hhmm}`, ...reply }
      : { action: "book_slot", ...reply };
  }
  if (/\[e2e-inventa\]/i.test(userText)) {
    return { action: "reply", text: AI_MOCK_INVENTED_SLOTS };
  }
  if (/\[e2e-horario-atencion\]/i.test(userText)) {
    return { action: "reply", text: AI_MOCK_ATTENTION_HOURS };
  }
  return null;
}
