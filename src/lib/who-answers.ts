/**
 * 031 — «Quién responde» este chat, para la franja bajo la cabecera del hilo
 * (y la pregunta en línea al empezar a escribir). Puro: lo usa
 * `who-answers-strip.tsx` y lo cubre `tests/unit/who-answers.test.ts`.
 *
 *   ai      — A: la IA está encendida, sin escalar, y el agente de la
 *             instancia de veras responde (configurado y encendido).
 *   human   — B: la IA está en pausa a mano (sin escalar). `who` dice quién
 *             la tiene: tú, otro miembro (vista del Propietario) o nadie.
 *   handoff — C: la IA escaló a una persona (`handoffAt`), con su motivo.
 *   none    — sin franja: el agente no responde en esta instancia, así que
 *             no se promete ni se pausa una IA que no existe.
 */

export type WhoAnswersInput = {
  aiEnabled: boolean;
  handoffAt: string | null;
  handoffReason: string | null;
  assignedTo: { userId: string; name: string } | null;
};

export type WhoAnswers =
  | { kind: "none" }
  | { kind: "ai" }
  | { kind: "human"; who: "me" | "nobody" | { name: string } }
  | { kind: "handoff"; reason: string | null };

export function whoAnswers(
  c: WhoAnswersInput,
  opts: {
    viewerId: string;
    /** ¿El agente de la instancia responde? (configurado ∧ encendido). */
    agentReady: boolean;
    /** Sin equipo (Propietario solo) todo chat es «tuyo». */
    teamMode: boolean;
  }
): WhoAnswers {
  // Un escalamiento es un hecho del chat: se muestra aunque el agente se
  // haya apagado después.
  if (c.handoffAt != null) return { kind: "handoff", reason: c.handoffReason };
  if (!opts.agentReady) return { kind: "none" };
  if (c.aiEnabled) return { kind: "ai" };
  if (!opts.teamMode || c.assignedTo?.userId === opts.viewerId) {
    return { kind: "human", who: "me" };
  }
  if (!c.assignedTo) return { kind: "human", who: "nobody" };
  return { kind: "human", who: { name: c.assignedTo.name || "otro miembro" } };
}

/**
 * ¿«Atender yo» debe además asignarte el chat? Solo en modo equipo y si
 * nadie lo tiene: el de otro miembro no se le quita por pausar la IA (eso es
 * reasignar, y lo hace el Propietario desde «Responsable»).
 */
export function takeOverAssigns(
  c: Pick<WhoAnswersInput, "assignedTo">,
  teamMode: boolean
): boolean {
  return teamMode && c.assignedTo === null;
}
