import { z } from "zod";
import { apiError, parseBody, requireOwner, withAuth } from "@/lib/api";
import { agendaFirst } from "@/server/agenda/flag";
import { getVisibleBooking } from "@/server/agenda/queries";
import {
  assignBooking,
  cancelBooking,
  markBookingStatus,
  moveBooking,
  rescheduleBooking,
  retryMeetingLink,
  takeBooking,
} from "@/server/agenda/service";
import { bookingErrorResponse } from "@/server/agenda/http";
import { notifyBookingAssigned, notifySafe } from "@/server/notifications/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type BookingRow = NonNullable<Awaited<ReturnType<typeof getVisibleBooking>>>;

/**
 * 035 B — «Te asignaron la cita de …» al NUEVO vendedor cuando el Propietario
 * la reasigna (`assign` o `move` con otro vendedor). Una sola vía: aquí, con
 * la sesión como actor. Nunca a quien la movió, nunca citas de prueba, y un
 * fallo no tumba la operación. «Tomarla» (uno mismo) no avisa.
 */
async function notifyReassigned(
  organizationId: string,
  actorUserId: string,
  before: BookingRow,
  after: BookingRow
): Promise<void> {
  if (before.isTest || after.assignedUserId === before.assignedUserId) return;
  await notifySafe("cita reasignada", () =>
    notifyBookingAssigned({
      organizationId,
      booking: after,
      toUserId: after.assignedUserId,
      actorUserId,
    })
  );
}

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reschedule"),
    startUtc: z.string().min(1),
    // 023 — Ya vio la advertencia `overlap_warning` y confirma.
    confirmOverlap: z.boolean().optional(),
  }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["realizada", "no_show"]),
  }),
  z.object({ action: z.literal("retry_link") }),
  // 023 — Reasignar el vendedor (`null` = sin asignar). Solo Propietario.
  z.object({ action: z.literal("assign"), userId: z.string().min(1).nullable() }),
  // 032 — «Tomarla»: quien pide se asigna a SÍ MISMO una cita sin vendedor.
  // Sin `userId`: siempre es la sesión. Cualquier rol.
  z.object({ action: z.literal("take") }),
  // 028 — Mover desde el calendario: hora y/o vendedor, atómico. Al menos
  // uno de los dos (se valida abajo). `userId` solo Propietario.
  z.object({
    action: z.literal("move"),
    startUtc: z.string().min(1).optional(),
    userId: z.string().min(1).nullable().optional(),
    confirmOverlap: z.boolean().optional(),
    expectedStartUtc: z.string().min(1).optional(),
  }),
]);

/**
 * 015 — Reprogramar, cancelar (idempotente), marcar el resultado o reintentar
 * el enlace que el proveedor no entregó.
 *
 * 023 — Una cita que el usuario no ve (de otro vendedor) responde 404, igual
 * que una inexistente. `reschedule` sigue las reglas de choque de humanos
 * (409 `slot_taken` / `overlap_warning`); `assign` es del Propietario (403 al
 * Vendedor) y rechaza con 409 `slot_taken` + `conflicts` si el nuevo vendedor
 * ya tiene una cita traslapada; 422 si no es miembro.
 *
 * 028 — `move` (calendario): hora y/o vendedor en una sola escritura, con
 * las reglas de reprogramar + reasignar; `userId` solo Propietario (403);
 * 409 `slot_taken` / `overlap_warning` / `stale`.
 *
 * 032 — `take` («Tomarla», decisión 2): cualquier rol se asigna a sí mismo
 * una cita que sigue sin vendedor, con un UPDATE condicional (atómico). Si
 * otro la tomó antes ⇒ 409 `already_taken` («Otro vendedor ya la tomó»).
 * No pasa por la visibilidad: la cita que otro acaba de tomar ya no se ve y
 * un 404 escondería el motivo; el servicio la lee con `scoped()` y no dice de
 * quién es.
 */
export const PATCH = agendaFirst(withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  if (body.data.action === "move") {
    if (body.data.startUtc === undefined && body.data.userId === undefined) {
      return apiError(422, "invalid_body", "Indica la nueva hora o el vendedor");
    }
  }
  // 023/028 — Reasignar (con `assign` o con `move` + `userId`) es del
  // Propietario.
  if (
    body.data.action === "assign" ||
    (body.data.action === "move" && body.data.userId !== undefined)
  ) {
    const denied = requireOwner(session);
    if (denied) return denied;
  }
  if (body.data.action === "take") {
    try {
      const { booking } = await takeBooking({
        organizationId: session.organizationId,
        bookingId: id,
        userId: session.userId,
      });
      return Response.json({ ok: true, assignedUserId: booking.assignedUserId });
    } catch (err) {
      return bookingErrorResponse(err);
    }
  }
  const visible = await getVisibleBooking(session.organizationId, id, {
    userId: session.userId,
    role: session.role,
  });
  if (!visible) return apiError(404, "not_found", "Cita no encontrada");

  try {
    switch (body.data.action) {
      case "reschedule": {
        const result = await rescheduleBooking({
          organizationId: session.organizationId,
          bookingId: id,
          startUtc: body.data.startUtc,
          mode: "staff",
          confirmOverlap: body.data.confirmOverlap ?? false,
        });
        return Response.json({ ok: true, label: result.label });
      }
      case "cancel": {
        await cancelBooking({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({ ok: true });
      }
      case "status": {
        await markBookingStatus({
          organizationId: session.organizationId,
          bookingId: id,
          status: body.data.status,
        });
        return Response.json({ ok: true });
      }
      case "retry_link": {
        const result = await retryMeetingLink({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({
          ok: true,
          meetingLink: result.meetingLink,
          linkPending: result.linkPending,
        });
      }
      case "assign": {
        const row = await assignBooking({
          organizationId: session.organizationId,
          bookingId: id,
          userId: body.data.userId,
        });
        await notifyReassigned(session.organizationId, session.userId, visible, row);
        return Response.json({ ok: true, assignedUserId: row.assignedUserId });
      }
      case "move": {
        const result = await moveBooking({
          organizationId: session.organizationId,
          bookingId: id,
          startUtc: body.data.startUtc,
          userId: body.data.userId,
          confirmOverlap: body.data.confirmOverlap ?? false,
          expectedStartUtc: body.data.expectedStartUtc,
        });
        await notifyReassigned(session.organizationId, session.userId, visible, result.booking);
        return Response.json({
          ok: true,
          label: result.label,
          scheduledAtUtc: result.booking.scheduledAt.toISOString(),
          assignedUserId: result.booking.assignedUserId,
        });
      }
    }
  } catch (err) {
    return bookingErrorResponse(err);
  }
}));
