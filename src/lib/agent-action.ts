/**
 * 025 — La acción de agenda que produjo un saliente del motor
 * (`message.agent_action`). La escribe SOLO el pipeline del agente.
 *
 * El historial del agente presenta esos salientes como la acción y no como un
 * `reply` con horas: si el modelo ve en su pasado listas de horarios escritas
 * "por él", aprende a escribirlas a mano (incidente del 21-oct).
 *
 * `shown` son las etiquetas cortas que el cliente VIO ("vie 23 oct 10:00"):
 * de ahí sale la marca `*` del bloque HORARIOS OFRECIDOS y la re-oferta "sin
 * repetir lo mostrado".
 *
 * `reply` (opcional, R3): la frase que el MODELO antepuso a la del motor
 * (p. ej. el precio que preguntó el cliente). Viaja en el historial dentro de
 * la acción para que el modelo recuerde qué contestó.
 */
export type AgentActionRecord =
  | {
      action: "offer_slots";
      type?: string | null;
      date?: string | null;
      part?: "mañana" | "tarde" | null;
      shown: string[];
      reply?: string | null;
    }
  | { action: "book_slot"; booked: string; reply?: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Lee un `agent_action` de BD con tolerancia: lo que no cuadra es null. */
export function parseAgentActionRecord(v: unknown): AgentActionRecord | null {
  if (!isRecord(v)) return null;
  const reply =
    typeof v.reply === "string" && v.reply.trim() ? { reply: v.reply } : {};
  if (v.action === "offer_slots") {
    const shown = Array.isArray(v.shown)
      ? v.shown.filter((s): s is string => typeof s === "string")
      : [];
    const part = v.part === "mañana" || v.part === "tarde" ? v.part : null;
    return {
      action: "offer_slots",
      type: typeof v.type === "string" ? v.type : null,
      date: typeof v.date === "string" ? v.date : null,
      part,
      shown,
      ...reply,
    };
  }
  if (v.action === "book_slot" && typeof v.booked === "string") {
    return { action: "book_slot", booked: v.booked, ...reply };
  }
  return null;
}
