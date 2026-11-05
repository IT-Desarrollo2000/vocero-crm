import { NextResponse, type NextRequest } from "next/server";
import { VOCERO_PATH_HEADER } from "@/lib/safe-next";

/**
 * 031 — Solo deja anotada la ruta pedida (`pathname + search`) en la cabecera
 * de petición `x-vocero-path`, para que el layout `(app)` pueda mandar al
 * login con `?next=` y volver ahí después (el link de `/ayuda` que llega por
 * WhatsApp).
 *
 * No decide NADA de sesión ni redirige: la guarda real sigue en el layout.
 * Corre en edge: nada de `@/lib/env` ni APIs de Node aquí. La cabecera se
 * sobrescribe siempre, así que lo que mande el cliente con ese nombre no
 * llega; y quien la lee la pasa igual por `safeNextPath`.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  // `_rsc` es interno de la navegación del cliente: no se lleva al `next`.
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.delete("_rsc");
  const search = params.toString();
  headers.set(
    VOCERO_PATH_HEADER,
    request.nextUrl.pathname + (search ? `?${search}` : "")
  );
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Fuera: la API (webhooks, auth, bot…), los estáticos de Next y cualquier
  // archivo con extensión (favicon, robots.txt, capturas de /ayuda…).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
