/**
 * 026 — "Por atender" que dice la verdad: entre los chats en manos de una
 * persona (escalados o con la IA apagada a mano), ¿el cliente espera
 * respuesta o ya se le atendió? Puro (sin BD ni React): lo usan la fila de
 * la Bandeja, el panel del contacto y sus tests.
 *
 * Las escrituras de `conversation.awaiting_since` viven en
 * `src/server/inbox/awaiting.ts`.
 */

/** Umbral por defecto para "atrasada" (decisión del dueño, spec 026). */
export const OVERDUE_DEFAULT_MINUTES = 60;
export const OVERDUE_MIN_MINUTES = 5;
export const OVERDUE_MAX_MINUTES = 1440;

/** Lo que hace falta de la conversación (subconjunto de `ConversationDto`). */
export type AwaitingInput = {
  handoffAt: string | null;
  aiEnabled: boolean;
  awaitingSince: string | null;
};

export type AwaitingState =
  /** No está en manos de una persona: la atiende la IA (o nadie la escaló). */
  | { kind: "none" }
  /** El cliente espera respuesta desde hace `ms`; `overdue` = pasó el umbral. */
  | { kind: "waiting"; ms: number; since: string; overdue: boolean }
  /** En manos de una persona y nadie le debe respuesta al cliente. */
  | { kind: "attended" };

/** En manos de una persona = escalada o con la IA apagada a mano. */
export function inHumanHands(c: Pick<AwaitingInput, "handoffAt" | "aiEnabled">): boolean {
  return c.handoffAt != null || c.aiEnabled === false;
}

/**
 * Estado de la espera a `now` (ms). Una hora futura (relojes desfasados) o
 * ilegible cuenta como espera de 0: el chat sigue "Esperando" (mejor avisar
 * de más que esconder a un cliente).
 */
export function awaitingState(
  c: AwaitingInput,
  now: number,
  overdueMinutes: number = OVERDUE_DEFAULT_MINUTES
): AwaitingState {
  if (!inHumanHands(c)) return { kind: "none" };
  if (c.awaitingSince == null) return { kind: "attended" };
  const since = Date.parse(c.awaitingSince);
  const ms = Number.isFinite(since) ? Math.max(0, now - since) : 0;
  return {
    kind: "waiting",
    ms,
    since: c.awaitingSince,
    overdue: ms >= overdueMinutes * 60_000,
  };
}

/**
 * Tiempo de espera legible y corto: "menos de 1 min", "25 min",
 * "1 h 20 min", "3 h", "2 d", "2 d 5 h".
 */
export function formatWait(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

/** Umbral válido (5–1440 min, entero) o el de por defecto. */
export function normalizeOverdueMinutes(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= OVERDUE_MIN_MINUTES &&
    value <= OVERDUE_MAX_MINUTES
    ? value
    : OVERDUE_DEFAULT_MINUTES;
}
