import { withAuth } from "@/lib/api";
import { teamErrorResponse } from "@/server/team/http";
import { resetPassword } from "@/server/team/members";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ memberId: string }> };

/**
 * Restablece la contraseña de otro miembro: devuelve una temporal (se muestra
 * una sola vez) y revoca sus sesiones. La propia se cambia en "Mi cuenta".
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const { memberId } = await ctx.params;
  try {
    const temporaryPassword = await resetPassword(
      session.organizationId,
      session.userId,
      memberId
    );
    return Response.json({ temporaryPassword });
  } catch (err) {
    return teamErrorResponse(err);
  }
}, { role: "owner" });
