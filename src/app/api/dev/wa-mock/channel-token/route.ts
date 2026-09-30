import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { mockGuard } from "@/lib/dev-guard";
import {
  getInstagramCredentialsByOrg,
  saveInstagramCredentials,
} from "@/server/instagram/credentials";
import {
  getMessengerCredentialsByOrg,
  saveMessengerCredentials,
} from "@/server/messenger/credentials";

/**
 * 017 — Reemplaza el token guardado de un canal SIN validarlo.
 *
 * Reproduce lo que en la vida real pasa fuera del CRM: Meta revoca un token
 * que ya estaba guardado. Por la API normal no se puede (el PUT valida contra
 * Meta antes de guardar), y sin esto el camino "token muerto → reconectar"
 * no tendría cómo probarse de punta a punta.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  channel: z.enum(["instagram", "messenger"]),
  token: z.string().min(1),
});

export const POST = withAuth(async (session, req: Request) => {
  const guard = mockGuard();
  if (guard) return guard;
  const body = await parseBody(req, schema);
  if (!body.ok) return body.response;
  const { channel, token } = body.data;
  const orgId = session.organizationId;

  if (channel === "instagram") {
    const c = await getInstagramCredentialsByOrg(orgId);
    if (!c) return Response.json({ ok: false }, { status: 404 });
    await saveInstagramCredentials({ ...c, organizationId: orgId, token });
  } else {
    const c = await getMessengerCredentialsByOrg(orgId);
    if (!c) return Response.json({ ok: false }, { status: 404 });
    await saveMessengerCredentials({ ...c, organizationId: orgId, token });
  }
  return Response.json({ ok: true });
});
