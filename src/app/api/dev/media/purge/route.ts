import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { parseRetentionDays, runMediaPurge } from "@/server/media/purge";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Adelanta el reloj N días (p. ej. 31 para ver expirar lo de hoy). */
  advanceDays: z.number().min(0).max(3650).optional(),
});

/**
 * 018 — Fuerza UNA vuelta de la purga de adjuntos (solo entorno de pruebas:
 * 404 en producción o sin `WA_MOCK_ENABLED`). Llama `runMediaPurge` directo,
 * sin pasar por el reloj in-process, con la misma retención que él.
 *
 * POST `{ "advanceDays"?: 31 }` (JSON obligatorio; `{}` vale)
 *   → 200 `{ cutoff, expired }`
 *   · 422 `invalid_body` si `advanceDays` no es un número válido
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const advanceMs = (body.data.advanceDays ?? 0) * 24 * 60 * 60 * 1000;
  const now = new Date(Date.now() + advanceMs);
  return Response.json(
    await runMediaPurge(now, parseRetentionDays(process.env.MEDIA_RETENTION_DAYS))
  );
}
