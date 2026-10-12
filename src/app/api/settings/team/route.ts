import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { serializeMember, teamErrorResponse } from "@/server/team/http";
import { createOrRelinkMember, listMembers } from "@/server/team/members";

export const dynamic = "force-dynamic";

/** Equipo de la organización (solo Propietario: expone nombres y correos). */
export const GET = withAuth(async (session) => {
  const members = await listMembers(session.organizationId);
  return Response.json({ members: members.map(serializeMember) });
}, { role: "owner" });

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});

/**
 * Alta de cuenta de equipo (owner only): email + contraseña temporal (FR-061).
 * Un correo dado de baja se re-vincula (`relinked: true`) en vez de dar 409.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  try {
    const result = await createOrRelinkMember(session.organizationId, body.data);
    return Response.json(
      result.relinked ? { ok: true, relinked: true } : { ok: true },
      { status: 201 }
    );
  } catch (err) {
    return teamErrorResponse(err);
  }
}, { role: "owner" });
