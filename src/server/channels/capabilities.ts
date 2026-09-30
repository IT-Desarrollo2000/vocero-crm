import { CHANNEL_LABEL, type Channel, type ReplyMode } from "@/lib/channels";

/**
 * 014 — Capacidades declaradas por canal.
 *
 * El núcleo NO debe saber las reglas de WhatsApp: debe preguntarlas. Antes,
 * la ventana de 24 h y el "usa una plantilla aprobada" vivían incrustados en
 * el camino genérico de envío, así que cada canal nuevo tenía que pelearse con
 * suposiciones que no eran suyas — Instagram no tiene plantillas, y su salida
 * fuera de ventana es una etiqueta.
 *
 * Agregar un canal debería ser: escribir su adaptador y declarar aquí lo que
 * puede y no puede hacer.
 */

export type OutsideWindowStrategy =
  /** Solo se puede reabrir con una plantilla aprobada (WhatsApp). */
  | "template"
  /** Se marca el mensaje como respuesta de agente humano (Instagram, Messenger). */
  | "human_agent_tag"
  /** No hay forma: fuera de ventana no se envía. */
  | "none";

export type ChannelCapabilities = {
  /** Etiqueta legible, para mensajes de error dirigidos al operador. */
  label: string;
  /** Ventana de servicio en ms desde el último entrante; null = sin ventana. */
  windowMs: number | null;
  /** Qué se puede hacer cuando la ventana está cerrada. */
  outsideWindow: OutsideWindowStrategy;
  /**
   * 017: hasta cuándo vale la etiqueta de agente humano, en ms desde el
   * último entrante. Meta la acepta 7 días; después rechaza el envío, así que
   * el núcleo lo corta antes con un mensaje claro. null = no aplica.
   */
  humanAgentWindowMs: number | null;
  /** Límite de texto en BYTES (no caracteres); null = sin límite práctico. */
  maxTextBytes: number | null;
  /** 017: límite en CARACTERES (Messenger cuenta así); null = sin límite. */
  maxTextChars: number | null;
  /** ¿Se pueden mandar adjuntos por este canal hoy? */
  outboundMedia: boolean;
  /** 017: ¿existen plantillas aprobadas en este canal? Solo WhatsApp. */
  templates: boolean;
  /**
   * ¿El estado del mensaje avanza por webhook (entregado/leído)? Si no, la
   * aceptación de la plataforma es la confirmación y el mensaje nace `sent`
   * — sin esto se queda con el reloj puesto para siempre.
   */
  deliveryReceipts: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_CAPABILITIES: Record<Channel, ChannelCapabilities> = {
  whatsapp: {
    label: CHANNEL_LABEL.whatsapp,
    windowMs: DAY_MS,
    outsideWindow: "template",
    humanAgentWindowMs: null,
    maxTextBytes: null,
    maxTextChars: null,
    outboundMedia: true,
    templates: true,
    deliveryReceipts: true,
  },
  instagram: {
    label: CHANNEL_LABEL.instagram,
    windowMs: DAY_MS,
    outsideWindow: "human_agent_tag",
    humanAgentWindowMs: 7 * DAY_MS,
    // Meta corta en 1000 bytes: con acentos y emojis el margen real es menor
    // de lo que aparenta al contar caracteres.
    maxTextBytes: 1000,
    maxTextChars: null,
    outboundMedia: false,
    templates: false,
    deliveryReceipts: false,
  },
  messenger: {
    label: CHANNEL_LABEL.messenger,
    windowMs: DAY_MS,
    outsideWindow: "human_agent_tag",
    humanAgentWindowMs: 7 * DAY_MS,
    // Messenger documenta 2000 caracteres. Se cuenta por puntos de código
    // (un emoji es uno), que es lo que la plataforma mide.
    maxTextBytes: null,
    maxTextChars: 2000,
    outboundMedia: false,
    templates: false,
    // Messenger sí manda entregas y lecturas, pero por "marca de agua" de
    // tiempo, no por id de mensaje: fuera del alcance del 017.
    deliveryReceipts: false,
  },
};

export function capabilitiesFor(channel: Channel): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel] ?? CHANNEL_CAPABILITIES.whatsapp;
}

/**
 * 017 — Cómo puede responder HOY un operador humano esta conversación.
 *
 * Es la única fuente de la regla: la usan el envío (para rechazar o etiquetar)
 * y el DTO de la bandeja (para que el compositor muestre lo que corresponde).
 * El agente IA NO la usa: la etiqueta de agente humano es, por política de
 * Meta, solo para humanos, así que la IA hace handoff al cerrarse las 24 h.
 */
export function replyModeFor(
  channel: Channel,
  lastInboundAt: Date | null,
  now: Date = new Date()
): ReplyMode {
  const caps = capabilitiesFor(channel);
  if (caps.windowMs === null) return "free";
  const elapsed = lastInboundAt
    ? now.getTime() - lastInboundAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (elapsed < caps.windowMs) return "free";

  switch (caps.outsideWindow) {
    case "template":
      return "template";
    case "human_agent_tag":
      return caps.humanAgentWindowMs !== null &&
        elapsed < caps.humanAgentWindowMs
        ? "human_agent"
        : "closed";
    case "none":
      return "closed";
  }
}

/** Mensaje para el operador cuando la ventana está cerrada, según el canal. */
export function windowClosedMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  switch (caps.outsideWindow) {
    case "template":
      return "La ventana de 24 horas está cerrada; usa una plantilla aprobada";
    case "human_agent_tag":
      // Dentro de los 7 días no se le pide nada al operador: el envío sale
      // etiquetado solo. Este texto es para cuando ya pasaron.
      return `Pasaron más de 7 días desde el último mensaje del cliente: ${caps.label} no permite retomar la conversación hasta que vuelva a escribir`;
    case "none":
      return `La ventana de ${caps.label} está cerrada y este canal no permite reabrirla`;
  }
}

/** ¿Este texto cabe en el canal? */
export function textFits(channel: Channel, text: string): boolean {
  const caps = capabilitiesFor(channel);
  if (
    caps.maxTextBytes !== null &&
    Buffer.byteLength(text, "utf8") > caps.maxTextBytes
  ) {
    return false;
  }
  if (caps.maxTextChars !== null && [...text].length > caps.maxTextChars) {
    return false;
  }
  return true;
}

/** Mensaje para el operador cuando el texto no cabe en el canal. */
export function textTooLongMessage(channel: Channel): string {
  const caps = capabilitiesFor(channel);
  return caps.maxTextChars !== null
    ? `${caps.label} no acepta mensajes de más de ${caps.maxTextChars} caracteres: acorta el texto`
    : `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`;
}
