/**
 * 033 — «Plantilla enviada» y candado contra duplicados. Puro y sin React:
 * lo usan el servidor (`server/whatsapp/templates.ts`, el texto del 409), la
 * Bandeja (`template-sender.tsx`, la tarjeta) y lo cubre
 * `tests/unit/template-sent.test.ts`.
 */
import type { MessageDto } from "@/lib/types";

/**
 * Ventana del candado, en minutos: la acordada con el dueño (capacitación de
 * ventas, 11-nov-2026). La misma plantilla con el mismo texto a la misma
 * conversación dentro de este lapso pide confirmación.
 */
export const TEMPLATE_DUPLICATE_WINDOW_MIN = 10;

/** Código del 409 que el formulario convierte en aviso con «Enviar de todos modos». */
export const TEMPLATE_DUPLICATE_CODE = "template_recently_sent";

/** Minutos completos entre el envío previo y ahora (nunca negativo). */
export function minutesSince(sentAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / 60_000));
}

/** «Ya le enviaste este mensaje a {nombre} hace {n} min.» */
export function duplicateMessage(name: string | null, minutes: number): string {
  const who = name ?? "este cliente";
  const when = minutes < 1 ? "hace menos de 1 min" : `hace ${minutes} min`;
  return `Ya le enviaste este mensaje a ${who} ${when}.`;
}

/** Lo que la Bandeja necesita del último envío de plantilla. */
export type LastTemplate = {
  id: string;
  createdAt: string;
  status: MessageDto["status"];
  text: string | null;
  error: string | null;
};

/**
 * La tarjeta «Plantilla enviada» se deriva del hilo (datos del servidor, no
 * de un estado local): el último mensaje es saliente, de origen `template`, y
 * por lo tanto no hay un entrante posterior. Así sigue al recargar y la ve
 * cualquiera que abra el chat. `null` = mostrar los pasos.
 */
export function lastTemplateSent(
  messages: readonly MessageDto[],
  conversationId?: string
): LastTemplate | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  // Mientras llega el hilo nuevo puede quedar el del chat anterior.
  if (conversationId && last.conversationId !== conversationId) return null;
  if (last.direction !== "out" || last.origin !== "template") return null;
  return {
    id: last.id,
    createdAt: last.createdAt,
    status: last.status,
    text: last.text,
    error: last.error,
  };
}

/** El estado de entrega en palabras (chip de la tarjeta). */
export function templateStatusLabel(status: MessageDto["status"]): string {
  switch (status) {
    case "pending":
      return "Enviando…";
    case "sent":
      return "Enviada";
    case "delivered":
      return "Entregada";
    case "read":
      return "Leída";
    case "failed":
      return "No se entregó";
  }
}

const VARIABLE = /\{\{\s*\d+\s*\}\}/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ¿De qué plantilla salió este texto? El mensaje guarda solo el cuerpo ya
 * sustituido (sin `template_id`), así que se reconstruye: cada `{{n}}` acepta
 * cualquier valor. Si ninguna o más de una coincide, `null` (la tarjeta
 * omite el nombre).
 */
export function matchTemplateByText<T extends { id: string; body: string }>(
  text: string | null,
  templates: readonly T[]
): T | null {
  if (!text) return null;
  const hits = templates.filter((t) => {
    const parts = t.body.split(VARIABLE).map(escapeRegex);
    return new RegExp(`^${parts.join("[\\s\\S]+?")}$`).test(text);
  });
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
