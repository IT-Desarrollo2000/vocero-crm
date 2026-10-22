import { BookingError, type BookingResult } from "@/server/agenda/service";
import type { BusyItem } from "@/server/agenda/conflicts";

/**
 * 015 — La traducción entre el dominio y HTTP, en un solo sitio.
 *
 * Vive aquí y no dentro de los `route.ts` por dos razones: Next solo admite
 * handlers como exports de una ruta (así que no serían testeables), y porque
 * los códigos y la FORMA del error son contrato observable, no un detalle.
 *
 * Las dos lecciones que costaron caro en producción y que este módulo fija:
 *  - Crear responde **201**, no 200. Un cliente que validaba `=== 200` dejó a
 *    todos los leads sin agendar durante horas, y los mocks no lo vieron
 *    porque respondían 200.
 *  - El error va ANIDADO (`{"error":{"code":…}}`) con `slots` como HERMANO. Un
 *    mock con la forma plana escondió el camino de re-oferta durante semanas:
 *    todo 409 se leía como conflicto genérico y las alternativas nunca se
 *    ofrecían.
 */

export type BookingPayload = {
  bookingId: string;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

export function bookingPayload(result: BookingResult): BookingPayload {
  return {
    bookingId: result.booking.id,
    meetingLink: result.meetingLink,
    /**
     * true ⇒ la cita EXISTE pero el proveedor aún no entregó el enlace.
     * Confirma la cita y di que el enlace llega luego; no prometas uno que no
     * tienes.
     */
    linkPending: result.linkPending,
    label: result.label,
  };
}

export function bookingErrorStatus(code: BookingError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid":
      return 422;
    case "slot_taken":
    case "slot_not_offered":
    case "overlap_warning":
    // 028 — `move` con `expectedStartUtc` vencido: otra persona ya la movió.
    case "stale":
      return 409;
  }
}

/**
 * 023 — Lo que se expone de una cita con la que se choca. El detalle de una
 * cita ajena se limita a tipo, vendedor y hora (plan §5): nada de contacto ni
 * notas.
 */
export type ConflictPayload = {
  bookingId: string;
  typeName: string | null;
  sellerName: string | null;
  startUtc: string;
  endUtc: string;
};

export function conflictPayload(item: BusyItem): ConflictPayload {
  return {
    bookingId: item.id,
    typeName: item.typeName,
    sellerName: item.sellerName,
    startUtc: item.startUtc,
    endUtc: item.endUtc,
  };
}

/**
 * Traduce un `BookingError` al sobre estándar. Cualquier otro error se relanza.
 *
 * 023 — `overlap_warning` (409) lleva `conflicts` como HERMANO del error,
 * igual que `slots` en `slot_taken`: la UI pide confirmación con ese detalle.
 */
export function bookingErrorResponse(err: unknown): Response {
  if (!(err instanceof BookingError)) throw err;
  const code = err.code === "invalid" ? "invalid_body" : err.code;
  const status = bookingErrorStatus(err.code);
  if (err.code === "overlap_warning") {
    return Response.json(
      {
        error: { code, message: err.message },
        conflicts: err.conflicts.map(conflictPayload),
      },
      { status }
    );
  }
  return Response.json(
    {
      error: { code, message: err.message },
      slots: err.slots,
      // Aditivo: solo cuando el choque viene con detalle (reasignar/reactivar).
      ...(err.conflicts.length > 0
        ? { conflicts: err.conflicts.map(conflictPayload) }
        : {}),
    },
    { status }
  );
}
