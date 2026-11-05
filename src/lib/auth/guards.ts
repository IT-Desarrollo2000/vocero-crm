import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSessionOrNull, type SessionContext } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";
import { loginPathFor, VOCERO_PATH_HEADER } from "@/lib/safe-next";

/**
 * 031 — A qué login mandar a quien llegó sin sesión: con `?next=` a la ruta
 * que pidió (la anota `src/middleware.ts`), para volver ahí al entrar. Lo
 * usan TODAS las guardas de página: layout y página se pintan en paralelo, y
 * si una mandara a `/login` a secas podría ganarle a la otra y perder el
 * destino.
 *
 *   if (!session) redirect(await loginRedirectPath());
 */
export async function loginRedirectPath(): Promise<string> {
  const h = await headers();
  return loginPathFor(h.get(VOCERO_PATH_HEADER));
}

/**
 * Guarda de páginas server (layouts/pages) solo del Propietario:
 * sin sesión → redirect a /login (igual que `(app)/layout.tsx`);
 * Vendedor → notFound() (404 de la app, mismo patrón que las banderas).
 * Devuelve la sesión ya validada.
 */
export async function requireOwnerPage(): Promise<SessionContext> {
  const session = await getSessionOrNull();
  if (!session) redirect(await loginRedirectPath());
  if (!isOwner(session)) notFound();
  return session;
}
