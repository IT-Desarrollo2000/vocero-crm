import { z } from "zod";
import { apiError, parseBody, requireOwner, withAuth } from "@/lib/api";
import { isOwner } from "@/lib/roles";
import { parseRangeQuery, type DateRange } from "@/lib/time/calendar";
import { agendaFirst } from "@/server/agenda/flag";
import {
  bookingOverlaps,
  listBookings,
  listBookingsInRange,
  rangeBoundsUtc,
  type BookingListFilters,
} from "@/server/agenda/queries";
import { getSettings } from "@/server/agenda/settings";
import { createBlock, createSessionBooking } from "@/server/agenda/service";
import {
  bookingErrorResponse,
  bookingPayload,
  conflictPayload,
} from "@/server/agenda/http";
import { appointmentTypeDto, listTypes } from "@/server/agenda/types-store";
import { listMembers } from "@/server/team/members";

export const dynamic = "force-dynamic";

/**
 * 015 — Citas del negocio.
 *
 * 023 — Visibilidad por vendedor: el Vendedor ve las suyas, las que creó y
 * las sin asignar (incluye bloqueos); el Propietario, todo. Filtros:
 * `sellerId` (`none` = sin asignar) y `typeId`. Además viajan `types` (tipos
 * activos) y, solo para el Propietario, `sellers` (miembros `{id, name}`),
 * para que la pantalla no necesite otra llamada.
 *
 * 028 — Con `?from=AAAA-MM-DD&to=AAAA-MM-DD` (días del NEGOCIO, inclusivos,
 * máximo 92) responde el calendario: TODAS las citas visibles que tocan el
 * rango, en orden ascendente, más `range`, `truncated`, `hours` (lo mínimo del
 * horario para pintar la rejilla; el Vendedor no lee los ajustes) y
 * `overlaps` (`{[bookingId]: "soft"|"hard"}`, ver `overlaps.ts`). Un rango que
 * no cuadra es 422 `invalid_range`. Sin rango, EXACTAMENTE lo de antes.
 */
export const GET = agendaFirst(withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const sellerParam = url.searchParams.get("sellerId");
  const typeId = url.searchParams.get("typeId") || undefined;
  const owner = isOwner(session);
  const filters = {
    viewer: { userId: session.userId, role: session.role },
    sellerId:
      sellerParam === null || sellerParam === ""
        ? undefined
        : sellerParam === "none"
          ? null
          : sellerParam,
    typeId,
  };

  const query = parseRangeQuery(
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );
  if (!query.ok) return apiError(422, "invalid_range", query.message);
  if (query.range) {
    return rangeResponse(session.organizationId, query.range, filters, owner);
  }

  const [bookings, settings, types, members] = await Promise.all([
    listBookings(session.organizationId, filters),
    getSettings(session.organizationId),
    listTypes(session.organizationId),
    owner ? listMembers(session.organizationId) : Promise.resolve(null),
  ]);
  // 10 — `businessTimezone` (aditivo): el Vendedor no puede leer
  // `/api/calendar/settings` y la UI formatea en la zona del NEGOCIO la hora
  // de envío de cada recordatorio pendiente, no en la del navegador.
  return Response.json({
    bookings,
    businessTimezone: settings.timezone,
    types: types.map(appointmentTypeDto),
    ...(members
      ? { sellers: members.map((m) => ({ id: m.userId, name: m.name })) }
      : {}),
  });
}));

/** 028 — La respuesta del calendario (con rango). */
async function rangeResponse(
  organizationId: string,
  range: DateRange,
  filters: BookingListFilters,
  owner: boolean
): Promise<Response> {
  const settings = await getSettings(organizationId);
  const [{ bookings, truncated }, types, members] = await Promise.all([
    listBookingsInRange(organizationId, range, { ...filters, settings }),
    listTypes(organizationId),
    owner ? listMembers(organizationId) : Promise.resolve(null),
  ]);
  const overlaps = await bookingOverlaps(
    organizationId,
    rangeBoundsUtc(range, settings.timezone),
    bookings.map((b) => b.id)
  );
  return Response.json({
    bookings,
    businessTimezone: settings.timezone,
    types: types.map(appointmentTypeDto),
    ...(members
      ? { sellers: members.map((m) => ({ id: m.userId, name: m.name })) }
      : {}),
    range,
    truncated,
    // Solo estos cinco campos: los ajustes completos traen la dirección y la
    // sala del negocio, que el Vendedor no necesita.
    hours: {
      weeklyHours: settings.weeklyHours,
      slotMinutes: settings.slotMinutes,
      bufferMinutes: settings.bufferMinutes,
      minNoticeHours: settings.minNoticeHours,
      timezone: settings.timezone,
    },
    overlaps,
  });
}

const postSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    contactId: z.string().min(1),
    conversationId: z.string().min(1).nullish(),
    startUtc: z.string().min(1),
    notes: z.string().nullish(),
    // 023 — El tipo es obligatorio para humanos (A2).
    typeId: z.string().min(1),
    // 023 — Solo el Propietario elige vendedor (A5); `null` = sin asignar.
    assignedUserId: z.string().min(1).nullish(),
    // 023 — Ya vio la advertencia `overlap_warning` y confirma.
    confirmOverlap: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("block"),
    startUtc: z.string().min(1),
    durationMinutes: z.number().int().min(5).max(600),
    notes: z.string().nullish(),
  }),
]);

/**
 * 015 — El operador agenda o bloquea.
 *
 * Responde **201**, igual que la superficie del bot: el código de creación es
 * contrato, no un detalle.
 *
 * A diferencia del agente, el operador NO pasa por `offered_slot`: elige de la
 * disponibilidad que está viendo en pantalla. La re-validación bajo el candado
 * por organización sí aplica igual.
 *
 * 023 — Choques: incompatible ⇒ 409 `slot_taken`; compatible sin
 * `confirmOverlap` ⇒ 409 `overlap_warning` con `conflicts`. Un bloqueo encima
 * de citas se permite y responde `affected` (las citas que pisa).
 */
export const POST = agendaFirst(withAuth(async (session, req: Request) => {
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  try {
    if (body.data.kind === "block") {
      const { block, affected } = await createBlock({
        organizationId: session.organizationId,
        startUtc: body.data.startUtc,
        durationMinutes: body.data.durationMinutes,
        notes: body.data.notes ?? null,
      });
      return Response.json(
        { booking: { id: block.id }, affected: affected.map(conflictPayload) },
        { status: 201 }
      );
    }

    if (body.data.assignedUserId !== undefined) {
      const denied = requireOwner(session);
      if (denied) return denied;
    }

    const result = await createSessionBooking({
      organizationId: session.organizationId,
      contactId: body.data.contactId,
      conversationId: body.data.conversationId ?? null,
      startUtc: body.data.startUtc,
      notes: body.data.notes ?? null,
      source: "manual",
      requireOffer: false,
      typeId: body.data.typeId,
      assignedUserId: body.data.assignedUserId,
      actorUserId: session.userId,
      confirmOverlap: body.data.confirmOverlap ?? false,
    });
    return Response.json(
      { booking: { id: result.booking.id }, ...bookingPayload(result) },
      { status: 201 }
    );
  } catch (err) {
    return bookingErrorResponse(err);
  }
}));
