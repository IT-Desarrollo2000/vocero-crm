import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { runAutoArchive } from "@/server/inbox/archive";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Adelanta el reloj N días (p. ej. 15 para ver archivar lo de hoy). */
  advanceDays: z.number().min(0).max(3650).optional(),
});

/**
 * 022 — Fuerza UNA vuelta del auto-archivo (solo entorno de pruebas: 404 en
 * producción o sin `WA_MOCK_ENABLED`). Pasa por `runAutoArchive`, así que
 * respeta el interruptor de cada organización: apagado no archiva nada.
 *
 * POST `{ "advanceDays"?: 15 }` (JSON obligatorio; `{}` vale)
 *   → 200 `{ now, organizations, archived, failed }`
 *   · 422 `invalid_body` si `advanceDays` no es un número válido
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const advanceMs = (body.data.advanceDays ?? 0) * 24 * 60 * 60 * 1000;
  const now = new Date(Date.now() + advanceMs);
  return Response.json(await runAutoArchive(now));
}
