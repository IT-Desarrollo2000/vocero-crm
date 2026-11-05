import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

/**
 * Conmuta el `GET {pageId}/conversations` del mock (nombre de Messenger sin
 * Business Asset User Profile Access).
 *
 * POST `{ "mode": "ok" | "down" }` → `{ fbConversations }`
 *   `down` = 400 de Meta: con un PSID "sinperfil" fallan las dos vías y el
 *   contacto queda con el respaldo ("Contacto de Messenger").
 * `DELETE /api/dev/wa-mock/outbox` (reset total) también lo deja en `ok`.
 */
const bodySchema = z.object({
  mode: z.enum(["ok", "down"]),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const state = getWaMockState();
  state.fbConversations = body.data.mode;
  return Response.json({ fbConversations: state.fbConversations });
}
