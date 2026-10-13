import { apiError } from "@/lib/api";
import { TeamError, type TeamMember } from "@/server/team/members";

/** Forma pública de un miembro (contrato de /api/settings/team/*). */
export function serializeMember(m: TeamMember) {
  return {
    id: m.id,
    userId: m.userId,
    role: m.role,
    name: m.name,
    email: m.email,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * Traduce un TeamError a la respuesta estándar (`apiError`). Cualquier otro
 * error se relanza para que `withAuth` lo convierta en 500 sin stack.
 */
export function teamErrorResponse(err: unknown): Response {
  if (err instanceof TeamError) return apiError(err.status, err.code, err.message);
  throw err;
}
