import { createHmac } from "node:crypto";
import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { apiError, parseBody } from "@/lib/api";
import { getEnv } from "@/lib/env";

/**
 * 017 — Simula un DM entrante de Instagram o de Messenger.
 *
 * Construye el payload real de Meta (`entry[].messaging[]`, el mismo formato
 * en los dos canales) y lo entrega por loopback al webhook público del canal,
 * FIRMADO con el secreto que ese webhook espera. Así el self-test ejercita el
 * token de la ruta, la firma y la ingesta de verdad, no un atajo.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  channel: z.enum(["instagram", "messenger"]),
  /** IG_ID del perfil (Instagram) o id de la Página (Messenger). */
  accountId: z.string().min(1),
  /** IGSID o PSID de quien escribe. */
  senderId: z.string().min(1),
  text: z.string().optional(),
  mid: z.string().min(1),
  /** ms epoch; por defecto, ahora. */
  timestamp: z.number().optional(),
  /** Simula el eco de un mensaje que mandó la propia cuenta. */
  echo: z.boolean().optional(),
  /** Eventos crudos adicionales en el mismo `messaging[]` (delivery, read…). */
  extraEvents: z.array(z.record(z.unknown())).optional(),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, schema);
  if (!body.ok) return body.response;
  const d = body.data;
  const env = getEnv();

  const timestamp = d.timestamp ?? Date.now();
  const payload = {
    object: d.channel === "instagram" ? "instagram" : "page",
    entry: [
      {
        id: d.accountId,
        time: timestamp,
        messaging: [
          ...(d.extraEvents ?? []),
          {
            // En un eco el remitente es la cuenta y el destinatario el cliente.
            sender: { id: d.echo ? d.accountId : d.senderId },
            recipient: { id: d.echo ? d.senderId : d.accountId },
            timestamp,
            message: {
              mid: d.mid,
              ...(d.text !== undefined ? { text: d.text } : {}),
              ...(d.echo ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(payload);
  const secret =
    d.channel === "instagram"
      ? env.IG_APP_SECRET || env.META_APP_SECRET
      : env.FB_APP_SECRET || env.META_APP_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    headers["x-hub-signature-256"] = `sha256=${sig}`;
  }

  const port = process.env.PORT ?? "3000";
  const segment = d.channel === "instagram" ? "ig" : "fb";
  const res = await fetch(
    `http://127.0.0.1:${port}/api/webhooks/${segment}/${env.META_WEBHOOK_VERIFY_TOKEN}`,
    { method: "POST", headers, body: raw }
  );
  if (!res.ok) {
    return apiError(502, "webhook_error", `El webhook respondió ${res.status}`);
  }
  return Response.json({ delivered: true });
}
