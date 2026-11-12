import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { runNotificationTick } from "@/server/notifications/tick";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Reloj simulado (ISO-8601). Sin él, la hora real. */
  now: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Fecha ilegible (ISO-8601)")
    .optional(),
});

/**
 * 035 B — Fuerza UNA vuelta del reloj de avisos (solo entorno de pruebas:
 * 404 en producción o sin `WA_MOCK_ENABLED`). En el E2E el reloj in-process
 * va apagado (`NOTIFICATIONS_TICK_MS=0`) y solo avanza por aquí.
 *
 * Llama `runNotificationTick(now)` DIRECTO: dos POST seguidos con el mismo
 * `now` ejercitan el UNIQUE de `notification` (el segundo no crea nada).
 *
 * POST `{ "now"?: "2026-11-12T16:00:00.000Z" }` (JSON obligatorio; `{}` vale)
 *   → 200 `{ due, daily, purged, failedOrgs }` · 422 `invalid_body`
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const now = body.data.now ? new Date(body.data.now) : new Date();
  return Response.json(await runNotificationTick(now));
}
