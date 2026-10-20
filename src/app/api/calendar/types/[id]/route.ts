import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  AppointmentTypeError,
  appointmentTypeDto,
  updateType,
} from "@/server/agenda/types-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: z.string().max(200).optional(),
    durationMinutes: z.number().int().optional(),
    exclusive: z.boolean().optional(),
    active: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nada que cambiar",
  });

/**
 * 023 — Editar, reordenar (`position`) o desactivar un tipo de cita. No hay
 * DELETE: las citas viejas lo referencian; se desactiva (`active:false`).
 *
 * PATCH (Propietario) → 200 `{ type }` · 404 `not_found` · 422 `invalid_body`.
 * Con `AGENDA` apagada, 404 antes de mirar la sesión.
 */
export async function PATCH(req: Request, ctx: Params) {
  if (!agendaEnabled()) return agendaDisabledResponse();
  return withAuth(
    async (session) => {
      const { id } = await ctx.params;
      const body = await parseBody(req, patchSchema);
      if (!body.ok) return body.response;
      try {
        const type = await updateType(session.organizationId, id, body.data);
        return Response.json({ type: appointmentTypeDto(type) });
      } catch (err) {
        if (err instanceof AppointmentTypeError) {
          return err.code === "not_found"
            ? apiError(404, "not_found", err.message)
            : apiError(422, "invalid_body", err.message);
        }
        throw err;
      }
    },
    { role: "owner" }
  )();
}
