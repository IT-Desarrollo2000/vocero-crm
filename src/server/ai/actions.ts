import { z } from "zod";

/**
 * 04 — Parche de ficha que puede acompañar a CUALQUIER acción (D-04-1): el
 * contrato es una acción por turno, y una acción aparte le robaría la
 * respuesta al cliente.
 *
 * Permisivo a propósito: un `ficha` que no sea objeto se descarta (`.catch`)
 * en vez de invalidar la acción — un dato raro del modelo jamás convierte el
 * turno en reintentos ni en handoff `error`. La validación por tipo ocurre
 * DESPUÉS, en la puerta (`upsertFicha` → `coerceFichaPatch`).
 */
const FichaPatch = z.record(z.unknown()).nullable().optional().catch(undefined);

/**
 * Acción tipada del agente: exactamente UNA por turno (FR-021).
 * El servidor valida cada acción contra sus allowlists (etapas de la org);
 * lo que no valida se degrada, nunca se ejecuta a ciegas.
 */
const baseActions = [
  z.object({ action: z.literal("none"), ficha: FichaPatch }),
  z.object({ action: z.literal("reply"), text: z.string().min(1), ficha: FichaPatch }),
  z.object({
    action: z.literal("update_lead"),
    note: z.string().min(1),
    reply: z.string().optional(),
    ficha: FichaPatch,
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().optional(),
    ficha: FichaPatch,
  }),
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
    ficha: FichaPatch,
  }),
] as const;

/**
 * 015 — Las dos acciones de agenda. Solo se registran si esta instancia tiene
 * la bandera encendida: donde no hay agenda, el modelo ni siquiera puede
 * nombrarlas.
 *
 * `reply` es una introducción opcional, NO la lista de horarios: los horarios
 * los pega el motor con las etiquetas reales. Y `startUtc` tiene que ser
 * exactamente uno de los que el sistema ofreció — si no, el motor lo rechaza y
 * se re-ofrece.
 */
const agendaActions = [
  z.object({
    action: z.literal("offer_slots"),
    /**
     * 023 — Nombre del tipo de cita. TOLERANTE: vacío, nulo o de otro tipo
     * se vuelve ausente (el motor pregunta el tipo); nunca tumba el turno.
     */
    type: z
      .unknown()
      .transform((v) =>
        typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
      )
      .optional(),
    reply: z.string().optional(),
    ficha: FichaPatch,
  }),
  z.object({
    action: z.literal("book_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
    ficha: FichaPatch,
  }),
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const nonEmptyText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * Tolerancias de forma ANTES de validar (RF-04-04):
 * - `{"action":"update_ficha", ficha, text|reply?}` (alias) → `reply` con ese
 *   texto, o `none` si no trae; conserva `ficha`.
 * - `reply` sin `text` pero con `reply` → `text = reply` (los modelos mezclan
 *   las dos claves).
 * Todo lo demás pasa tal cual: un `reply` que sigue sin texto es inválido
 * AUNQUE traiga `ficha` (→ reintento; tras 3 fallos, handoff `error`
 * visible). Volverlo `none` dejaría al cliente sin respuesta en silencio.
 */
export function normalizeAgentOutput(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  if (raw.action === "update_ficha") {
    const text = nonEmptyText(raw.text)
      ? raw.text
      : nonEmptyText(raw.reply)
        ? raw.reply
        : undefined;
    return text
      ? { action: "reply", text, ficha: raw.ficha }
      : { action: "none", ficha: raw.ficha };
  }
  if (raw.action === "reply" && !nonEmptyText(raw.text)) {
    if (nonEmptyText(raw.reply)) return { ...raw, text: raw.reply };
  }
  return raw;
}

const fullUnion = z.discriminatedUnion("action", [
  ...baseActions,
  ...agendaActions,
]);
const baseUnion = z.discriminatedUnion("action", [...baseActions]);

export type AgentActionType = z.infer<typeof fullUnion>;

export const AgentAction = z.preprocess(normalizeAgentOutput, fullUnion);

/** El esquema que se le exige al modelo en ESTE turno. */
export function agentActionSchema(
  agenda: boolean
): z.ZodType<AgentActionType, z.ZodTypeDef, unknown> {
  return agenda
    ? AgentAction
    : z.preprocess(normalizeAgentOutput, baseUnion);
}

/**
 * Resuelve el nombre de etapa devuelto por el modelo contra las etapas reales
 * de la organización (exacto → lower-case). Sin match: degradar a reply/none.
 */
export function resolveStage(
  requested: string,
  stages: { id: string; name: string }[]
): { id: string; name: string } | null {
  const exact = stages.find((s) => s.name === requested.trim());
  if (exact) return exact;
  const lower = requested.trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === lower) ?? null;
}

/**
 * Degrada una acción que no se pudo ejecutar (FR-021 / contrato ai.md).
 * La ficha que traía se conserva: el dato es del cliente, no de la acción.
 */
export function degradeAction(action: AgentActionType): AgentActionType {
  if (
    action.action === "move_stage" ||
    action.action === "offer_slots" ||
    action.action === "book_slot"
  ) {
    const ficha = action.ficha ? { ficha: action.ficha } : {};
    return action.reply
      ? { action: "reply", text: action.reply, ...ficha }
      : { action: "none", ...ficha };
  }
  return action;
}
