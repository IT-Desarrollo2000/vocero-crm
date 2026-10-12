import { isOwner, type Role } from "@/lib/roles";
import type { SseEvent } from "./bus";

/**
 * ¿Esta conexión SSE debe recibir el evento? (tarea 00, RF-00-03 / T-00-12).
 *
 * Hoy solo filtra por rol: el progreso del Laboratorio (`lab.run`) es del
 * Propietario. El resto se entrega a toda la organización; la visibilidad por
 * asignación de conversaciones llega con la tarea 09 y se agrega AQUÍ, para
 * que `/api/events` siga sin saber de reglas.
 *
 * El rol se toma al abrir la conexión: un cambio de rol surte efecto al
 * reconectar (≤ un heartbeat), igual que la baja de un miembro.
 */
export function canReceive(event: SseEvent, viewer: { role: Role }): boolean {
  if (event.type === "lab.run") return isOwner(viewer);
  return true;
}
