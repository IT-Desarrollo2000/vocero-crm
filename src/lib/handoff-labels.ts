/**
 * Etiquetas en español del motivo de escalamiento (`conversation.handoffReason`).
 *
 * Tipado contra el enum de la columna: si el schema agrega un motivo y aquí
 * falta su etiqueta, no compila — así fue como `hostilidad` quedó cayendo al
 * texto genérico del panel.
 */

// Solo tipos (se borra al compilar): el panel es cliente y no arrastra la BD.
import type { conversation } from "@/lib/db/schema";

type HandoffReason = NonNullable<
  (typeof conversation.$inferSelect)["handoffReason"]
>;

export const HANDOFF_LABELS: Record<HandoffReason, string> = {
  cliente: "El cliente pidió un humano",
  modelo: "El agente decidió escalar",
  error: "Error del proveedor de IA",
  ventana: "Ventana de 24h cerrada",
  hostilidad: "El cliente se puso agresivo — el agente se retiró",
  manual_reply: "Respondiste desde el teléfono — IA en pausa",
};

/** Texto cuando no hay motivo o llega uno desconocido. */
export const HANDOFF_FALLBACK_LABEL = "La IA está en pausa en esta conversación.";

export function handoffLabel(reason: string | null | undefined): string {
  return (
    (HANDOFF_LABELS as Record<string, string | undefined>)[reason ?? ""] ??
    HANDOFF_FALLBACK_LABEL
  );
}
