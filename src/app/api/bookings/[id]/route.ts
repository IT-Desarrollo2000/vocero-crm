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
} from "@/server/agenda/service";
import { bookingErrorResponse } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

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
