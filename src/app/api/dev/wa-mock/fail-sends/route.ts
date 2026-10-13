import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * 10 — Conmuta la falla de los envíos de WhatsApp del mock (camino infeliz
 * del self-test: recordatorio fallido → reintento con el mock sano).
 *
 * GET  → `{ failSends: "off" | "error" | "down" }`
 * POST `{ "mode": "off" | "error" | "down" }` → `{ failSends }`
 *   `error` = 400 de Meta (131026) → `meta_error` con motivo legible;
 *   `down`  = 503 → `meta_unavailable`.
 * `DELETE /api/dev/wa-mock/outbox` (reset total) también lo deja en `off`.
 */
const bodySchema = z.object({
  mode: z.enum(["off", "error", "down"]),
});

export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  return Response.json({ failSends: getWaMockState().failSends ?? "off" });
}

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const state = getWaMockState();
  state.failSends = body.data.mode;
  return Response.json({ failSends: state.failSends });
}
