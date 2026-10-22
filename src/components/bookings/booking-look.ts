import type { BookingListItem } from "@/server/agenda/queries";
import type { OverlapLevel } from "@/server/agenda/overlaps";

/**
 * 028 — Cómo se ve y cómo se nombra una cita, igual en Semana, Día y el panel
 * de detalle. Nombre y forma tomados de upstream (215); colores según A7:
 * solo tokens, nada de color solo (cada estado lleva ícono o texto).
 */

export type Booking = BookingListItem;

export const STATUS_LABEL: Record<Booking["status"], string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

/** Un bloqueo no se "agenda" ni se "cancela": está activo o se quitó. */
export function statusLabel(b: Pick<Booking, "kind" | "status">): string {
  if (b.kind === "block") return b.status === "cancelada" ? "Bloqueo quitado" : "Bloqueo";
  return STATUS_LABEL[b.status];
}

/** Lo que se lee en la rejilla: el contacto o, en un bloqueo, su nota. */
export function bookingTitle(b: Pick<Booking, "kind" | "notes" | "contact">): string {
  if (b.kind === "block") return b.notes?.trim() || "Bloqueo";
  return b.contact?.name.trim() || "Sin contacto";
}

/** Texto del atributo de traslape (A4). */
export const OVERLAP_TEXT: Record<OverlapLevel, string> = {
  soft: "Traslape con otro vendedor",
  hard: "Conflicto",
};

/**
 * A7 — Clases del bloque por estado. Agendada: relleno del acento; realizada:
 * verde apagado; no asistió: rojo apagado; bloqueo: rayado; cancelada:
 * tachada y translúcida. El traslape `hard` se suma como borde de alerta y el
 * `soft` como franja ámbar a la izquierda.
 */
export function bookingTone(
  b: Pick<Booking, "kind" | "status" | "isTest">,
  overlap?: OverlapLevel | null
): string {
  let box: string;
  if (b.status === "cancelada") {
    box = "border-dashed border-border-strong bg-subtle text-text-3 line-through opacity-70";
  } else if (b.kind === "block") {
    box = "booking-hatch border-border-strong text-text-2";
  } else if (b.status === "realizada") {
    box = "border-success-soft bg-success-tint text-success-text";
  } else if (b.status === "no_show") {
    box = "border-danger-soft bg-danger-tint text-danger-text";
  } else {
    box = "border-transparent bg-brand text-brand-fg";
  }
  if (b.isTest) box += " border-dashed opacity-80";
  if (overlap === "hard" && b.status !== "cancelada") {
    box += " border-2 border-danger";
  } else if (overlap === "soft" && b.status !== "cancelada") {
    // El dueño pidió distinguir lo traslapado también por color: franja
    // ámbar discreta, sin tapar el color de estado (el ícono ⧉ sigue).
    box += " border-l-4 border-l-warning";
  }
  return box;
}

/**
 * `aria-label` completo del bloque: hora, cliente, tipo, vendedor, estado y
 * traslape, para no depender del color ni de los íconos.
 */
export function bookingAriaLabel(
  b: Pick<
    Booking,
    "kind" | "status" | "notes" | "contact" | "type" | "assignedUser" | "isTest"
  >,
  timeRange: string,
  overlap?: OverlapLevel | null
): string {
  const parts = [timeRange, bookingTitle(b)];
  if (b.kind === "session") {
    if (b.type) parts.push(b.type.name);
    parts.push(b.assignedUser?.name ? `con ${b.assignedUser.name}` : "sin asignar");
  }
  parts.push(statusLabel(b));
  if (b.isTest) parts.push("prueba");
  if (overlap) parts.push(OVERLAP_TEXT[overlap]);
  return parts.filter(Boolean).join(", ");
}
