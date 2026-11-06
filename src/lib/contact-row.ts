/**
 * 032 — Contactos «que se explican solos». Puro: lo usa
 * `src/components/contacts/contacts-client.tsx` y lo cubre
 * `tests/unit/contact-row.test.ts`.
 *
 * Dada una fila del directorio (contacto + su conversación real, si existe),
 * quién mira y la hora, decide qué dice la fila (quién lo atiende y cómo va
 * su chat, en palabras) y cuál es su acción: abrir el chat, retomarlo con
 * plantilla, escribirle primero o ninguna — y entonces, por qué.
 *
 * Mismas reglas que Seguimiento: de quién es el chat (`ownershipOf`), quién
 * puede abrirlo (`canOpenChatFor`) y cómo se le puede contestar hoy
 * (`replyModeFor`, la regla de la Bandeja), recalculado desde
 * `lastInboundAt` y el `now` inyectado. Nada aquí lee `Date.now()`.
 */

import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import {
  canOpenChatFor,
  ownershipOf,
  whenLabel,
  type CardViewer,
  type Ownership,
} from "@/lib/pipeline-card";
import { firstName } from "@/lib/quick-replies";
import { isOwner } from "@/lib/roles";
import { capabilitiesFor, replyModeFor } from "@/server/channels/capabilities";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export type RowConversation = {
  id: string;
  channel: Channel;
  assignedTo: { id: string; name: string } | null;
  lastInboundAt: string | null;
};

export type RowContact = {
  id: string;
  channel: Channel;
  /** null en contactos que llegaron solo con BSUID (003). */
  phone: string | null;
  conversation: RowConversation | null;
};

export type RowAction =
  /** `strong`: botón lleno (puede escribirle libre); si no, discreto. */
  | { kind: "open"; label: string; href: string; strong: boolean }
  | { kind: "template"; label: string; href: string }
  /** Abre los 3 pasos de la plantilla aquí mismo (sin conversación). */
  | { kind: "first"; label: string }
  /**
   * Vendedor ante un chat sin tomar (con equipo): la misma toma atómica que
   * Seguimiento (`takeChat`, `expect: "unassigned"`) y luego a `href`.
   */
  | { kind: "take"; label: string; conversationId: string; href: string };

export type RowTone = "success" | "warning" | "neutral";

export type RowView = {
  ownership: Ownership;
  canOpenChat: boolean;
  /** «tú lo atiendes» · «nadie lo atiende todavía» · «lo atiende Marco Ríos». */
  who: string | null;
  /** Una línea en palabras: cómo va su chat (o por qué no hay acción). */
  status: string;
  tone: RowTone;
  action: RowAction | null;
  /** Solo si no hay acción: el motivo, visible (es el mismo `status`). */
  reason: string | null;
};

/** «12 min» · «23 h»: cuánto le queda a la ventana, sin minutos sueltos. */
export function remainingLabel(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < HOUR_MS) return `${Math.max(1, Math.floor(safe / MIN_MS))} min`;
  if (safe < DAY_MS) return `${Math.floor(safe / HOUR_MS)} h`;
  const d = Math.ceil(safe / DAY_MS);
  return d === 1 ? "1 día" : `${d} días`;
}

/** «30 h» hasta dos días; después «3 días». */
export function silenceLabel(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < HOUR_MS) return `${Math.max(1, Math.floor(safe / MIN_MS))} min`;
  if (safe < 2 * DAY_MS) return `${Math.floor(safe / HOUR_MS)} h`;
  return `${Math.floor(safe / DAY_MS)} días`;
}

/** «Te escribió hace 12 min» sin el punto doble de «… p. m.». */
function wroteLine(mine: boolean, when: string): string {
  return `${mine ? "Te escribió" : "Escribió"} ${when}`;
}

export type RowContext = {
  viewer: CardViewer;
  now: number;
  /** Zona IANA del negocio: «hoy, 9:10 a. m.» se dice en ella. */
  tz: string;
};

export function contactRowView(contact: RowContact, ctx: RowContext): RowView {
  const { viewer, now, tz } = ctx;
  const conv = contact.conversation;
  const own = ownershipOf(
    { conversationId: conv?.id ?? null, assignedTo: conv?.assignedTo ?? null },
    viewer
  );
  const canOpenChat = canOpenChatFor(own, viewer);
  const href = `/inbox?contact=${contact.id}`;
  // Como Seguimiento: el Vendedor toma el chat sin responsable antes de
  // entrar. El Propietario lo abre sin tomarlo (no se auto-asigna, D-09-3).
  const take: RowAction | null =
    conv && own === "unassigned" && !isOwner(viewer)
      ? { kind: "take", label: "Tomar y responder", conversationId: conv.id, href }
      : null;
  const view = (
    status: string,
    tone: RowTone,
    windowAction: RowAction | null,
    who: string | null
  ): RowView => {
    const action = take ?? windowAction;
    return {
      ownership: own,
      canOpenChat,
      who,
      status,
      tone,
      action,
      reason: action ? null : status,
    };
  };

  // Sin conversación: nunca ha escrito (alta manual) o su chat no existe aún.
  if (!conv) {
    const label = CHANNEL_LABEL[contact.channel];
    if (contact.channel !== "whatsapp") {
      // En Instagram y Messenger no hay plantillas: la persona escribe primero.
      return view(`Por ${label} solo puedes contestarle cuando te escriba`, "neutral", null, null);
    }
    if (!contact.phone) {
      return view(
        "Sin teléfono: no hay a dónde mandarle el primer mensaje. Cuando te escriba, aparecerá su chat",
        "neutral",
        null,
        null
      );
    }
    return view(
      "Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado",
      "neutral",
      { kind: "first", label: "Escribir primero" },
      null
    );
  }

  const assignee = conv.assignedTo?.name || "otro vendedor";
  if (own === "other" && !isOwner(viewer)) {
    const who = firstName(conv.assignedTo?.name) || "su vendedor";
    return view(`Lo atiende ${assignee} · solo ${who} abre su chat`, "neutral", null, null);
  }

  const who =
    own === "other"
      ? `lo atiende ${assignee}`
      : own === "unassigned"
        ? "nadie lo atiende todavía"
        : viewer.teamMode
          ? "tú lo atiendes"
          : null;
  const mine = own === "mine";
  const channel = conv.channel;
  const label = CHANNEL_LABEL[channel];
  const last = conv.lastInboundAt ? new Date(conv.lastInboundAt) : null;
  const lastMs = last ? last.getTime() : null;
  const mode = replyModeFor(channel, last, new Date(now));
  const open = (strong: boolean): RowAction => ({ kind: "open", label: "Abrir chat", href, strong });

  if (mode === "free") {
    const caps = capabilitiesFor(channel);
    const left = caps.windowMs !== null && lastMs !== null ? caps.windowMs - (now - lastMs) : 0;
    const when = conv.lastInboundAt ? whenLabel(conv.lastInboundAt, now, tz) : "";
    return view(
      `${wroteLine(mine, when)} · puedes escribirle libremente ${remainingLabel(left)} más`,
      "success",
      open(true),
      who
    );
  }

  if (mode === "human_agent") {
    // Instagram/Messenger entre 24 h y 7 días: aún se le contesta (la Bandeja
    // etiqueta el envío como agente humano), pero con fecha de caducidad.
    const caps = capabilitiesFor(channel);
    const left =
      caps.humanAgentWindowMs !== null && lastMs !== null ? caps.humanAgentWindowMs - (now - lastMs) : 0;
    return view(
      `Por ${label} puedes contestarle ${remainingLabel(left)} más; después, solo cuando te vuelva a escribir`,
      "warning",
      open(false),
      who
    );
  }

  if (mode === "closed") {
    // Abrir el chat sigue sirviendo para leer el historial.
    return view(
      `Por ${label} solo puedes contestarle cuando te vuelva a escribir: pasaron más de 7 días`,
      "neutral",
      open(false),
      who
    );
  }

  // WhatsApp fuera de las 24 h.
  if (lastMs === null) {
    // Hay chat pero nunca contestó (lo abrió una plantilla).
    return view(
      "Aún no te contesta · para volver a escribirle usa un mensaje aprobado",
      "warning",
      { kind: "template", label: "Escribir con plantilla", href },
      who
    );
  }
  return view(
    `${mine ? "No te escribe" : "No escribe"} desde hace ${silenceLabel(now - lastMs)} · para retomarlo usa un mensaje aprobado`,
    "warning",
    { kind: "template", label: "Retomar con plantilla", href },
    who
  );
}
