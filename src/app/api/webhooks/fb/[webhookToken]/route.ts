import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { isValidSignature, isValidWebhookToken } from "@/server/inbox/webhook";
import { processMessengerPayload } from "@/server/messenger/ingest";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";

/**
 * 017 — Webhook público del canal de Messenger.
 *
 * Mismo patrón de dos capas que el de WhatsApp y el de Instagram: el segmento
 * [webhookToken] debe coincidir (si no → 404 sin efectos), y encima la firma
 * `x-hub-signature-256` con el secreto de la app que entrega los eventos.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ webhookToken: string }> };

export async function GET(req: Request, { params }: Params) {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const { webhookToken } = await params;
  const env = getEnv();
  if (!isValidWebhookToken(webhookToken, env.META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  // Handshake de suscripción de Meta.
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response(null, { status: 403 });
}

export async function POST(req: Request, { params }: Params) {
  if (!isChannelEnabled("messenger")) return channelDisabledResponse();
  const { webhookToken } = await params;
  const env = getEnv();
  if (!isValidWebhookToken(webhookToken, env.META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  const rawBody = await req.text();

  // Sin esta capa, quien conozca la URL secreta puede inyectar mensajes
  // falsos: el agente los contestaría enviando un mensaje REAL desde la
  // Página del cliente al PSID que el atacante elija.
  if (
    !isValidSignature(
      rawBody,
      req.headers.get("x-hub-signature-256"),
      env.FB_APP_SECRET || env.META_APP_SECRET
    )
  ) {
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Cuerpo ilegible: 200 igualmente para que Meta no reintente en vano.
    return Response.json({ received: true });
  }

  // Meta espera respuesta rápida y reintenta si tarda: se acusa recibo YA y
  // se procesa fuera de la ruta.
  after(async () => {
    try {
      await processMessengerPayload(payload);
    } catch (err) {
      console.error("[fb] error procesando payload:", err);
    }
  });

  return Response.json({ received: true });
}
