import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv, isAiConfigured } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { markHandoff } from "@/server/inbox/handoff";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import {
  fichaRenderOptions,
  loadContactContext,
  renderContactContext,
} from "@/server/ai/contact-context";
import { upsertFicha } from "@/server/bot/ficha";
import type { FichaFieldDef } from "@/lib/ficha-fields";
import { loadHistoryRows, toChatHistory } from "@/server/ai/history";
import { agendaEnabled } from "@/server/agenda/flag";
import { bookSlot, offerSlots } from "@/server/agenda/agent";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/** Punto de entrada con debounce (mensajes entrantes reales). */
export function scheduleAgentTurn(conversationId: string): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
  };
  map.set(conversationId, entry);

  if (entry.running) {
    entry.pending = true; // se re-encola al terminar el turno actual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  try {
    await runAgentTurn(conversationId);
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    if (entry.pending) {
      entry.pending = false;
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 */
export async function runAgentTurn(conversationId: string): Promise<void> {
  if (!isAiConfigured()) return;

  const db = getDb();
  // Lectura de arranque por id: el organizationId SALE de esta fila (el
  // turno solo recibe conversationId), así que todavía no hay tenant con qué
  // scopear. Todo lo que sigue va por scoped().
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  // Últimos 20 mensajes con su adjunto: los no-texto viajan como marcador
  // (03), no se descartan.
  const history = await loadHistoryRows(organizationId, conversationId);
  if (!history.some((m) => m.direction === "in")) return;
  const { messages: chatHistory, lastInboundText } = toChatHistory(history);

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return;
  }

  // Patrón de respaldo ANTES del LLM (FR-022) — sobre el texto o, si el
  // último entrante es una foto/video/documento, sobre su pie (RF-03-10).
  if (lastInboundText && matchesHandoffIntent(lastInboundText)) {
    await applyHandoff(conversationId, organizationId, "cliente");
    return;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();
  // 04 — Definición de campos (NULL = el agente no llena nada, RF-04-02).
  const fichaFields = profile.fichaFields ?? null;
  const contactBlock = await safeContactBlock(
    organizationId,
    conversation,
    fichaFields
  );
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        contactBlock,
        fichaFields,
      }),
    },
    // Los turnos previos van en el MISMO formato JSON que se le exige (con
    // texto plano, MiniMax imita su historial y deja de responder JSON desde
    // el segundo turno); los del equipo, marcados con "autor" (history.ts).
    ...chatHistory,
  ];

  const result = await chatJson(agentActionSchema(agenda), messages);
  if (!result.ok) {
    if (result.error === "not_configured") return;
    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return;
  }

  const chosen: AgentActionType = result.data;
  await executeAction(chosen, { organizationId, conversation, stages, agenda });

  // 04 — La ficha va DESPUÉS de entregar la respuesta (RF-04-10): el cliente
  // ya tiene su mensaje pase lo que pase aquí.
  await applyAgentFicha({
    organizationId,
    conversation,
    fields: fichaFields,
    ficha: chosen.ficha,
  });
}

/** Ejecuta la acción del turno (y entrega su respuesta, si la hay). */
async function executeAction(
  initial: AgentActionType,
  t: {
    organizationId: string;
    conversation: Conversation;
    stages: { id: string; name: string }[];
    agenda: boolean;
  }
): Promise<void> {
  const { organizationId, conversation, stages, agenda } = t;
  const conversationId = conversation.id;
  let action = initial;

  // 015 — Agenda. Un fallo del motor degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
                confirmation: action.reply,
              });
        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
      }
    }
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) {
        await deliverReply(conversation, action.reply);
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, action.text);
      return;
    case "update_lead": {
      await appendLeadNote(organizationId, conversation.contactId, action.note);
      if (action.reply) await deliverReply(conversation, action.reply);
      return;
    }
    case "handoff": {
      if (action.farewell) {
        await deliverReply(conversation, action.farewell);
      }
      // El catálogo dice "modelo"; el porqué concreto que explicó el modelo
      // viaja como nota para que el humano no herede el caso a ciegas.
      await applyHandoff(conversationId, organizationId, "modelo", action.reason);
      return;
    }
  }
}

type Conversation = typeof schema.conversation.$inferSelect;

/**
 * 03 — Bloque "DATOS DEL CONTACTO" del turno. Armar el contexto JAMÁS tumba
 * el turno (RF-03-13): si algo truena, se registra el tipo de error (sin
 * valores personales) y el agente responde sin la sección.
 */
async function safeContactBlock(
  organizationId: string,
  conversation: Conversation,
  fichaFields: readonly FichaFieldDef[] | null
): Promise<string | undefined> {
  try {
    const ctx = await loadContactContext({
      organizationId,
      conversation,
      now: new Date(),
    });
    // 04 — Mismo gancho que `GET /api/bot/context`: campos definidos primero
    // y lo que el agente no puede pisar, marcado "(confirmado por el equipo)".
    return renderContactContext(ctx, fichaRenderOptions(ctx, fichaFields));
  } catch (err) {
    console.error(
      `[agente] contexto no disponible: ${err instanceof Error ? err.name : typeof err}`
    );
    return undefined;
  }
}

/**
 * 04 — Escribe en la ficha lo que el agente descubrió en este turno, por la
 * puerta única (`source: "ia"`: coerción por tipo + "el humano gana").
 *
 * Nunca tumba el turno ni provoca handoff (RF-04-10): cualquier error se
 * registra con las CLAVES y el tipo de error, jamás con valores
 * (Constitución I). Sin campos que llene el agente, no hace nada (RF-04-02).
 * En el Laboratorio escribe igual sobre el contacto sintético (RF-04-15): es
 * la BD propia, no una API externa.
 */
async function applyAgentFicha(input: {
  organizationId: string;
  conversation: Conversation;
  fields: readonly FichaFieldDef[] | null;
  ficha: Record<string, unknown> | null | undefined;
}): Promise<void> {
  const { organizationId, conversation, fields, ficha } = input;
  if (!ficha || Object.keys(ficha).length === 0) return;
  if (!fields?.some((f) => f.agentFills)) return;
  try {
    const res = await upsertFicha({
      organizationId,
      contactId: conversation.contactId,
      ficha,
      source: "ia",
      fields,
      conversationId: conversation.id,
    });
    if (res?.changed) {
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversation.id } },
      });
    }
  } catch (err) {
    console.error(
      `[agente] ficha no guardada (claves: ${Object.keys(ficha).slice(0, 40).join(", ")}): ${err instanceof Error ? err.name : typeof err}`
    );
  }
}

/** Entrega la respuesta: envío real o persistencia sandbox (is_test). */
async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    throw err;
  }
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

/** El catálogo de motivos sale del enum de la columna: una sola fuente. */
export type ConversationHandoffReason = NonNullable<
  (typeof schema.conversation.$inferSelect)["handoffReason"]
>;

/**
 * Escalamiento del agente in-process. Pasa por la puerta única `markHandoff`
 * (05/02-0): solo escribe si no había handoff abierto (el primer motivo gana),
 * registra el evento y publica — salvo en el Laboratorio. No apaga la IA
 * (`ai_enabled` se queda como estaba): el agente se detiene por `handoff_at`.
 */
export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: ConversationHandoffReason,
  note?: string | null
): Promise<void> {
  await markHandoff({
    organizationId,
    conversationId,
    reason,
    note,
    source: "agente",
    pauseAi: false,
  });
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contact.id)
      )
    );
}
