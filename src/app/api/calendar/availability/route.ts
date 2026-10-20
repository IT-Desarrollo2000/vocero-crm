import { apiError, withAuth } from "@/lib/api";
import { isOwner } from "@/lib/roles";
import { dayIsoInTz, timeInTz, dayLabelInTz } from "@/lib/time/slots";
import { agendaFirst } from "@/server/agenda/flag";
import {
  computeAvailability,
  type AvailabilityOptions,
} from "@/server/agenda/availability";
import { STRICT, type ConflictContext } from "@/server/agenda/conflicts";
import { conflictPayload } from "@/server/agenda/http";
import { getVisibleBooking } from "@/server/agenda/queries";
import { getSettings } from "@/server/agenda/settings";
import { getType } from "@/server/agenda/types-store";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Los huecos libres, para el operador.
 *
 * A diferencia de la superficie del bot, esta NO registra oferta: es la vista
 * de quien ya está mirando la agenda y elige de lo que ve.
 *
 * Sin huecos responde `{"slots":[]}` con 200: agenda llena es una respuesta,
 * no un error.
 *
 * 023 — Rejilla por tipo y vendedor (modo `staff`):
 *  - `typeId`: duración del tipo; los huecos con citas compatibles vienen con
 *    `conflicts` (forma `conflictPayload`) y los incompatibles no aparecen.
 *    Tipo inexistente o inactivo ⇒ 422. Sin `typeId`, `strict` como en la 015.
 *  - `sellerId`: solo el Propietario elige (`none` = sin vendedor); para el
 *    Vendedor siempre es él mismo.
 *  - `excludeBookingId` (reprogramar, A7): tipo, duración y vendedor salen de
 *    ESA cita (que no se bloquea a sí misma); 404 si el usuario no la ve.
 */
export const GET = agendaFirst(withAuth(async (session, req: Request) => {

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const typeId = url.searchParams.get("typeId");
  const sellerParam = url.searchParams.get("sellerId");
  const excludeBookingId = url.searchParams.get("excludeBookingId");

  const viewer = { userId: session.userId, role: session.role };
  const sellerId = isOwner(session)
    ? sellerParam === "none"
      ? null
      : (sellerParam ?? session.userId)
    : session.userId;

  let ctx: ConflictContext = STRICT;
  let durationMinutes: number | undefined;
  if (excludeBookingId) {
    const booking = await getVisibleBooking(
      session.organizationId,
      excludeBookingId,
      viewer
    );
    if (!booking) return apiError(404, "not_found", "Cita no encontrada");
    durationMinutes = booking.durationMinutes;
    if (booking.kind === "session") {
      ctx = {
        mode: "staff",
        typeId: booking.appointmentTypeId,
        typeExclusive: booking.exclusive,
        sellerId: booking.assignedUserId,
      };
    }
  } else if (typeId) {
    const type = await getType(session.organizationId, typeId);
    if (!type || !type.active) {
      return apiError(422, "invalid_body", "Tipo de cita inválido");
    }
    durationMinutes = type.durationMinutes;
    ctx = {
      mode: "staff",
      typeId: type.id,
      typeExclusive: type.exclusive,
      sellerId,
    };
  }

  const settings = await getSettings(session.organizationId);
  const now = new Date();
  const opts: AvailabilityOptions = {
    fromISO: from && ISO_DATE.test(from) ? from : undefined,
    toISO: to && ISO_DATE.test(to) ? to : undefined,
    settings,
    now,
    durationMinutes,
    ctx,
    excludeBookingId: excludeBookingId ?? undefined,
  };
  const slots = await computeAvailability(session.organizationId, opts);

  return Response.json({
    slots: slots.map((s) => ({
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      label: s.label,
      dayIso: dayIsoInTz(new Date(s.startUtc), settings.timezone),
      dayLabel: dayLabelInTz(s.startUtc, settings.timezone, now),
      time: timeInTz(s.startUtc, settings.timezone),
      conflicts: s.conflicts.map(conflictPayload),
    })),
  });
}));
