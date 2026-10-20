import { z } from "zod";
import { apiError, parseBody, requireOwner, withAuth } from "@/lib/api";
import { agendaFirst } from "@/server/agenda/flag";
import { getVisibleBooking } from "@/server/agenda/queries";
import {
  assignBooking,
  cancelBooking,
  markBookingStatus,
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
 */
export const PATCH = agendaFirst(withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  if (body.data.action === "assign") {
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
    }
  } catch (err) {
    return bookingErrorResponse(err);
  }
}));
