import { apiError, withAuth } from "@/lib/api";
import { agendaFirst } from "@/server/agenda/flag";
import { getBookingClientCard } from "@/server/agenda/client-card";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 029 (US-3) — El cliente de una cita, pedido al abrirla. 404 si la cita no
 * existe o no le toca a quien pregunta (igual que el PATCH); `{ card: null }`
 * en un bloqueo. Con `restricted` solo viajan nombre y teléfono.
 */
export const GET = agendaFirst(withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const result = await getBookingClientCard(
    session.organizationId,
    { userId: session.userId, role: session.role },
    id
  );
  if (!result) return apiError(404, "not_found", "Cita no encontrada");
  return Response.json(result);
}));
