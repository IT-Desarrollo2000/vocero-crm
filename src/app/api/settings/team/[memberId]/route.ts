import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
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

/** Da de baja a un miembro: borra su membresía y todas sus sesiones. */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { memberId } = await ctx.params;
  try {
    await removeMember(session.organizationId, session.userId, memberId);
    return Response.json({ ok: true });
  } catch (err) {
    return teamErrorResponse(err);
  }
}, { role: "owner" });
