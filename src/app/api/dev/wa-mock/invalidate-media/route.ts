import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * 019 fase B — Simula que Meta ya no reconoce un id subido (media id de
 * WhatsApp o `attachment_id` de Messenger): desde ahora `/messages` con ese
 * id responde 400 (WhatsApp 131053; Messenger 100). Sirve para probar que el
 * CRM olvida el id cacheado y re-sube UNA vez.
 *
 * POST `{ "id": "media-up-…" }` o `{ "all": true }` (todo lo subido en este
 * proceso) → `{ invalid: [...] }`. `DELETE /api/dev/wa-mock/outbox` lo vacía.
 */
const bodySchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ all: z.literal(true) }),
]);

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const state = getWaMockState();
  const ids = "id" in body.data ? [body.data.id] : state.issuedUploadIds;
  for (const id of ids) state.invalidMediaIds.add(id);
  return Response.json({ invalid: [...state.invalidMediaIds] });
}
