import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { publish } from "@/server/events/bus";
import { serializeMember, teamErrorResponse } from "@/server/team/http";
import { changeRole, removeMember } from "@/server/team/members";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ memberId: string }> };

const patchSchema = z.object({
  role: z.enum(["owner", "member"]),
});

/** Cambia el rol de un miembro (Propietario ↔ Vendedor). */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { memberId } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  try {
    const member = await changeRole(
      session.organizationId,
      session.userId,
      memberId,
      body.data.role
    );
    return Response.json({ member: serializeMember(member) });
  } catch (err) {
    return teamErrorResponse(err);
  }
}, { role: "owner" });

/**
 * Da de baja a un miembro: borra su membresía y todas sus sesiones, y sus
 * conversaciones vuelven a "sin asignar" (09). `removeMember` resuelve tras
 * el commit: aquí ya se puede avisar por SSE (solo el id, RF-09-09).
 */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { memberId } = await ctx.params;
  try {
    const released = await removeMember(
      session.organizationId,
      session.userId,
      memberId
    );
    for (const id of released) {
      publish(session.organizationId, {
        type: "conversation.updated",
        data: { conversation: { id } },
      });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return teamErrorResponse(err);
  }
}, { role: "owner" });
