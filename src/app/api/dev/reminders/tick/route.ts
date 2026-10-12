import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { runReminderTick } from "@/server/agenda/reminders";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Reloj simulado (ISO-8601). Sin él, la hora real. */
  now: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Fecha ilegible (ISO-8601)")
    .optional(),
});

/**
 * 10 — Fuerza UNA vuelta del ticker de recordatorios (solo entorno de
 * pruebas: 404 en producción o sin `WA_MOCK_ENABLED`; 404 con AGENDA apagada).
 *
 * Llama `runReminderTick(now)` DIRECTO, sin pasar por el ticker in-process ni
 * su candado `inFlight`: dos POST en paralelo ejercitan el UNIQUE de
 * `booking_reminder` (el claim atómico), que es justo lo que el E2E verifica.
 *
 * POST `{ "now"?: "2026-10-12T15:00:00.000Z" }` (JSON obligatorio; `{}` vale)
 *   → 200 `ReminderTickResultDto` (`src/lib/reminders.ts`)
 *   · 422 `invalid_body` si `now` no es una fecha
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  if (!agendaEnabled()) return agendaDisabledResponse();

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const now = body.data.now ? new Date(body.data.now) : new Date();
  return Response.json(await runReminderTick(now));
}
