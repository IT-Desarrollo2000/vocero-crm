import { z } from "zod";
import { requireSession, UnauthorizedError, type SessionContext } from "@/lib/auth/session";
import { isOwner, type Role } from "@/lib/roles";

/** Respuesta de error estándar de la API interna (contrato api.md). */
export function apiError(
  status: number,
  code: string,
  message: string
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export type WithAuthOptions = {
  /** Rol mínimo exigido. Hoy solo "owner" restringe; sin rol = cualquiera. */
  role?: Role;
};

/** 403 estándar cuando la acción es solo del Propietario. */
function forbidden(): Response {
  return apiError(403, "forbidden", "Solo el Propietario puede hacer esto");
}

/**
 * Chequeo de Propietario DENTRO de un handler (políticas `any*` que bifurcan
 * por rol). Devuelve la Response 403 a retornar tal cual, o null si pasa —
 * mismo patrón que `parseBody` (resultado, no excepción):
 *
 *   const denied = requireOwner(session);
 *   if (denied) return denied;
 */
export function requireOwner(session: { role: Role }): Response | null {
  return isOwner(session) ? null : forbidden();
}

/**
 * Envuelve un route handler autenticado: resuelve la sesión (401 si no hay),
 * aplica la guarda de rol si se pide (`{ role: "owner" }` → 403 `forbidden`
 * sin ejecutar el handler ni leer el body), captura errores no controlados
 * (500 sin stack) y deja pasar Response.
 */
export function withAuth<Args extends unknown[]>(
  handler: (session: SessionContext, ...args: Args) => Promise<Response>,
  opts?: WithAuthOptions
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    let session: SessionContext;
    try {
      session = await requireSession();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return apiError(401, "unauthorized", "No autenticado");
      }
      throw err;
    }
    if (opts?.role === "owner" && !isOwner(session)) {
      return forbidden();
    }
    try {
      return await handler(session, ...args);
    } catch (err) {
      console.error("[api] error no controlado:", err);
      return apiError(500, "internal", "Error interno");
    }
  };
}

/** Parsea el body JSON con un esquema Zod; inválido → Response 422. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: apiError(422, "invalid_body", "El body debe ser JSON válido"),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      response: apiError(422, "invalid_body", detail),
    };
  }
  return { ok: true, data: parsed.data };
}
