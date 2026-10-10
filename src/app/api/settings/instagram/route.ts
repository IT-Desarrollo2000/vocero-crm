import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import {
  deleteInstagramCredentials,
  getInstagramCredentialsByOrg,
  saveInstagramCredentials,
  tokenLast4,
} from "@/server/instagram/credentials";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

/** 017: datos del webhook de Instagram para pegar en la app de Meta. */
function webhookInfo() {
  const env = getEnv();
  const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/ig/${env.META_WEBHOOK_VERIFY_TOKEN}`;
  return {
    url,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    isHttps: url.startsWith("https://"),
    signatureLayer: Boolean(env.IG_APP_SECRET || env.META_APP_SECRET),
  };
}

/** 014 — Estado de la conexión de Instagram (el token nunca sale entero). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  const creds = await getInstagramCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null, webhook: webhookInfo() });
  return Response.json({
    connection: {
      source: creds.source,
      igUserId: creds.igUserId,
      accountRef: creds.accountRef,
      username: creds.username,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
    webhook: webhookInfo(),
  });
});

const putSchema = z.object({
  source: z.enum(["zernio", "meta"]),
  igUserId: z.string().trim().min(1),
  accountRef: z.string().trim().min(1).nullish(),
  username: z.string().trim().nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Guarda la conexión validando ANTES contra la plataforma, igual que el
 * wizard de WhatsApp: un token que no sirve no llega a la base.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  if (data.source === "zernio" && !data.accountRef) {
    return apiError(
      422,
      "invalid_body",
      "En modo Zernio hace falta el accountId de la cuenta conectada"
    );
  }

  const check = await verify(data);
  if (!check.ok) {
    return apiError(check.status, check.code, check.message);
  }

  await saveInstagramCredentials({
    organizationId: session.organizationId,
    source: data.source,
    igUserId: data.igUserId,
    accountRef: data.accountRef ?? null,
    username: check.username ?? data.username ?? null,
    token: data.token,
    webhookSecret: data.webhookSecret ?? null,
  });

  return Response.json({ ok: true, username: check.username ?? null });
});

type Check =
  | { ok: true; username: string | null }
  | { ok: false; status: number; code: string; message: string };

async function verify(data: z.infer<typeof putSchema>): Promise<Check> {
  const url =
    data.source === "meta"
      ? `${process.env.IG_GRAPH_BASE_URL ?? "https://graph.instagram.com"}/${
          process.env.META_GRAPH_API_VERSION ?? "v25.0"
        }/me?fields=user_id,username`
      : `${process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1"}/inbox/conversations?limit=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: "platform_unavailable",
      message: "No se pudo contactar la plataforma; intenta de nuevo",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: 422,
      code: "invalid_token",
      message:
        data.source === "meta"
          ? "El token de Instagram no es válido o no tiene permiso de mensajes"
          : "La API key de Zernio no es válida",
    };
  }

  if (data.source === "meta") {
    // `me` responde dos ids: `id` es el de la cuenta DENTRO de esta app
    // (app-scoped) y `user_id` el de la cuenta profesional, que es el que
    // muestra el panel de Meta y el que llega en el webhook (entry.id).
    const json = (await res.json().catch(() => null)) as {
      id?: string;
      user_id?: string;
      username?: string;
    } | null;
    const accountId = json?.user_id ?? json?.id;
    if (accountId && accountId !== data.igUserId) {
      return {
        ok: false,
        status: 422,
        code: "id_mismatch",
        message: `El IG_ID del token es ${accountId}, no ${data.igUserId}`,
      };
    }
    return { ok: true, username: json?.username ?? null };
  }

  return { ok: true, username: null };
}

/** 017 — Desconecta la cuenta de Instagram. */
export const DELETE = withAuth(async (session) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  await deleteInstagramCredentials(session.organizationId);
  return Response.json({ ok: true });
});
