import { apiError, withAuth } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  ReminderError,
  reminderErrorStatus,
  retryReminder,
} from "@/server/agenda/reminders";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; reminderId: string }> };

/**
 * 10 — Reintento manual de un recordatorio `failed` (D-10-02: a lo sumo una
 * vez). Propietario y Vendedor: los dos operan Citas.
 *
 * POST sin cuerpo
 *   → 200 `ReminderRetryResultDto` (`src/lib/reminders.ts`) con la fila ya
 *     resuelta (`sent` | `failed` | `skipped`) tras el envío síncrono.
 *   · 404 `not_found`          recordatorio inexistente, de otra org o de otra cita
 *   · 409 `not_retryable`      no está `failed` (otro clic lo ganó, o ya salió)
 *   · 409 `retry_exhausted`    ya se usó el reintento manual
 *   · 409 `booking_not_active` la cita no está `agendada` o faltan < 15 min
 *   · 404 sin cuerpo con AGENDA apagada.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const { id, reminderId } = await ctx.params;

  try {
    const reminder = await retryReminder({
      organizationId: session.organizationId,
      bookingId: id,
      reminderId,
      now: new Date(),
    });
    return Response.json({ ok: true, reminder });
  } catch (err) {
    if (err instanceof ReminderError) {
      return apiError(reminderErrorStatus(err.code), err.code, err.message);
    }
    throw err;
  }
});
