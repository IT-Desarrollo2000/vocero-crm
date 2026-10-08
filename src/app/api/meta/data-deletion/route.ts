import { getEnv } from "@/lib/env";
import {
  newConfirmationCode,
  parseSignedRequest,
} from "@/server/meta/data-deletion";

/**
 * Callback público de eliminación de datos de Meta (Configuración → Básica →
 * "URL de devolución de llamada de eliminación de datos").
 * Vocero no guarda datos indexados por el user_id de Facebook Login, así que
 * no hay nada que borrar automáticamente: se registra la solicitud con su
 * código y se remite a las instrucciones (atención manual por correo/canal).
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const env = getEnv();
  const secret = env.FB_APP_SECRET || env.META_APP_SECRET;
  if (!secret) return new Response(null, { status: 503 });

  const form = await req.formData().catch(() => null);
  const signed = form?.get("signed_request");
  if (typeof signed !== "string" || !parseSignedRequest(signed, secret)) {
    return Response.json({ error: "invalid_signed_request" }, { status: 400 });
  }

  const code = newConfirmationCode();
  // Sin el user_id: es un identificador personal y aquí no hace falta.
  console.info(`[meta] solicitud de eliminación de datos codigo=${code}`);
  return Response.json({
    url: `${env.APP_BASE_URL}/eliminacion-datos?codigo=${code}`,
    confirmation_code: code,
  });
}
