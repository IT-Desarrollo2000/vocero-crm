import { z } from "zod";
import { apiError, parseBody, requireOwner, withAuth } from "@/lib/api";
import { APPOINTMENT_TYPE_LIMITS } from "@/lib/agenda-types";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  AppointmentTypeError,
  appointmentTypeDto,
  createType,
  listTypes,
} from "@/server/agenda/types-store";

export const dynamic = "force-dynamic";

/**
 * 023 — Catálogo de tipos de cita (Prueba de manejo, Servicio…).
 *
 * La bandera va ANTES de la sesión: con `AGENDA` apagada esto no existe
 * (404), ni siquiera para quien no tiene sesión.
 *
 * GET (cualquier rol) → 200 `{ types: AppointmentTypeDto[] }` activos por
 *   `position` (siembra perezosa al primer uso). `?all=1` incluye los
 *   desactivados: solo Propietario (403 al Vendedor).
 * POST (Propietario) `{ name, durationMinutes, exclusive?, position? }` → 201
 *   `{ type }` · 422 `invalid_body`.
 */
export async function GET(req: Request) {
  if (!agendaEnabled()) return agendaDisabledResponse();
  return withAuth(async (session) => {
    const all = new URL(req.url).searchParams.get("all") === "1";
    if (all) {
      const denied = requireOwner(session);
      if (denied) return denied;
    }
    const types = await listTypes(session.organizationId, {
      includeInactive: all,
    });
    return Response.json({ types: types.map(appointmentTypeDto) });
  })();
}

const createSchema = z.object({
  name: z.string().min(1).max(APPOINTMENT_TYPE_LIMITS.name.max * 2),
  durationMinutes: z.number().int(),
  exclusive: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export async function POST(req: Request) {
  if (!agendaEnabled()) return agendaDisabledResponse();
  return withAuth(
    async (session) => {
      const body = await parseBody(req, createSchema);
      if (!body.ok) return body.response;
      try {
        const type = await createType(session.organizationId, body.data);
        return Response.json(
          { type: appointmentTypeDto(type) },
          { status: 201 }
        );
      } catch (err) {
        if (err instanceof AppointmentTypeError) {
          return apiError(422, "invalid_body", err.message);
        }
        throw err;
      }
    },
    { role: "owner" }
  )();
}
