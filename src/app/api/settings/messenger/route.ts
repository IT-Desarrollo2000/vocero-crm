import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import {
  deleteMessengerCredentials,
  getMessengerCredentialsByOrg,
  getMessengerCredentialsByPageId,
  saveMessengerCredentials,
} from "@/server/messenger/credentials";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

/** Datos del webhook de Messenger para pegar en la app de Meta. */
function webhookInfo() {
  const env = getEnv();
  const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/fb/${env.META_WEBHOOK_VERIFY_TOKEN}`;
  return {
    url,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    isHttps: url.startsWith("https://"),
    signatureLayer: Boolean(env.FB_APP_SECRET || env.META_APP_SECRET),
  };
}

/** 017 — Estado de la conexión de Messenger (el token nunca sale entero). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const creds = await getMessengerCredentialsByOrg(session.organizationId);
  return Response.json({
    connection: creds
      ? {
          pageId: creds.pageId,
          pageName: creds.pageName,
          status: creds.status,
          tokenLast4: creds.token.slice(-4),
        }
      : null,
    webhook: webhookInfo(),
  });
});

const putSchema = z.object({
  pageId: z
    .string()
    .trim()
    .regex(/^\d+$/, "El id de la Página son solo dígitos"),
  token: z.string().trim().min(1),
});

type DebugTokenInfo = {
  is_valid?: boolean;
  type?: string;
  profile_id?: string;
};

/**
 * Guarda la conexión validando ANTES contra Graph, igual que el wizard de
 * WhatsApp: un token que no sirve, o que es de otra Página, no llega a la
 * base. Después suscribe la Página a la app para que Meta entregue sus
 * mensajes al webhook.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const { pageId, token } = body.data;

  // `debug_token` sobre el propio token y no `me`: leer cualquier campo de la
  // Página (incluso `id`) exige `pages_read_engagement`, que Messenger no
  // necesita. `debug_token` dice el tipo, la Página dueña y si es válido.
  let info: DebugTokenInfo | undefined;
  try {
    const debug = await graphRequest<{ data?: DebugTokenInfo }>(
      `debug_token?input_token=${encodeURIComponent(token)}`,
      { token }
    );
    info = debug.data;
  } catch (err) {
    if (err instanceof MetaApiError && (err.status === 0 || err.status >= 500)) {
      return apiError(
        503,
        "platform_unavailable",
        "No se pudo contactar a Meta; intenta de nuevo"
      );
    }
  }
  if (!info?.is_valid || info.type !== "PAGE") {
    return apiError(
      422,
      "invalid_token",
      "El token no es válido o no es un token de Página"
    );
  }
  if (info.profile_id && info.profile_id !== pageId) {
    return apiError(
      422,
      "id_mismatch",
      `El token es de la Página ${info.profile_id}, no de ${pageId}`
    );
  }

  // El nombre es solo cosmético: sin `pages_read_engagement` Meta no lo da.
  const page = await graphRequest<{ name?: string }>("me?fields=name", {
    token,
  }).catch(() => ({ name: undefined }));

  // La Página enruta el webhook: solo puede pertenecer a una organización.
  const owner = await getMessengerCredentialsByPageId(pageId);
  if (owner && owner.organizationId !== session.organizationId) {
    return apiError(
      422,
      "page_in_use",
      "Esa Página ya está conectada a otra organización de esta instancia"
    );
  }

  await saveMessengerCredentials({
    organizationId: session.organizationId,
    pageId,
    pageName: page.name ?? null,
    token,
  });

  // Sin esta suscripción Meta no entrega los mensajes de la Página aunque el
  // webhook de la app esté configurado. No bloquea el guardado: si falla (el
  // token no trae pages_manage_metadata) se le dice al operador qué falta.
  let subscribed = true;
  try {
    await graphRequest(`${pageId}/subscribed_apps`, {
      method: "POST",
      token,
      body: { subscribed_fields: ["messages"] },
    });
  } catch {
    subscribed = false;
  }

  return Response.json({
    ok: true,
    pageName: page.name ?? null,
    subscribed,
    ...(subscribed
      ? {}
      : {
          warning:
            "La Página quedó guardada, pero no se pudo suscribir a la app: el token necesita el permiso pages_manage_metadata",
        }),
  });
});

/** Desconecta la Página: deja de recibir y de enviar por Messenger. */
export const DELETE = withAuth(async (session) => {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  await deleteMessengerCredentials(session.organizationId);
  return Response.json({ ok: true });
});
