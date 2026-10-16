import { mockGuard } from "@/lib/dev-guard";
import {
  getWaMockState,
  isInvalidMediaId,
  nextN,
  nextOutboundWamid,
  recordUpload,
  type MockTemplate,
  type OutboxEntry,
} from "@/server/dev/wa-mock-state";
import { mockDeclaredMime, mockMediaBytes } from "@/server/dev/wa-mock-media";

/**
 * Imitación de la Graph API (contrato mocks.md). El cliente real apunta aquí
 * cuando META_GRAPH_BASE_URL = <app>/api/dev/wa-mock/graph — el código de
 * producción no sabe que habla con un mock.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

/** 016 — Catálogo cerrado de Meta para `business_messaging` (mismo que el real). */
const CAPI_EVENT_NAMES = new Set([
  "Purchase",
  "LeadSubmitted",
  "QualifiedLead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
  "OrderCreated",
  "OrderShipped",
  "OrderDelivered",
  "OrderCanceled",
  "OrderReturned",
  "CartAbandoned",
  "RatingProvided",
  "ReviewProvided",
]);

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function invalidTokenResponse(): Response {
  return Response.json(
    {
      error: {
        message: "Invalid OAuth access token - Cannot parse access token",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "mock",
      },
    },
    { status: 401 }
  );
}

/**
 * 017 — Id "dueño" del token, para probar que el CRM rechaza un token de otra
 * cuenta: un token que termina en `-id<dígitos>` pertenece a ese id. Sin
 * sufijo, el token es de la cuenta que se le pregunte.
 */
function ownerIdFromToken(token: string): string | null {
  return /-id(\d+)$/.exec(token)?.[1] ?? null;
}

/**
 * 017 — Caminos infelices de Instagram/Messenger por token: `-down` = la
 * plataforma caída (5xx); `-nohumanagent` = la app sin la función Human
 * Agent aprobada, que Meta rechaza con un error de permiso. null = seguir.
 */
function channelSendFailure(token: string, tag: unknown): Response | null {
  if (token.endsWith("-down")) {
    return Response.json(
      { error: { message: "Service temporarily unavailable", type: "OAuthException", code: 2, fbtrace_id: "mock" } },
      { status: 503 }
    );
  }
  if (token.endsWith("-nohumanagent") && tag === "HUMAN_AGENT") {
    return Response.json(
      { error: { message: "(#10) This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2018278, fbtrace_id: "mock" } },
      { status: 400 }
    );
  }
  return null;
}

function graphParamError(message: string): Response {
  return Response.json(
    { error: { message, type: "GraphMethodException", code: 100, fbtrace_id: "mock" } },
    { status: 400 }
  );
}

function parseJsonField(v: FormDataEntryValue | null): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Quita el segmento de versión (v25.0/...) si viene en la ruta. */
function normalizePath(path: string[]): string[] {
  return path[0] && /^v\d+/.test(path[0]) ? path.slice(1) : path;
}

export async function GET(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // GET {wabaId}/message_templates → lista para el sync
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    return Response.json({
      data: state.templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components ?? [{ type: "BODY", text: t.body }],
      })),
    });
  }

  // GET {mediaId} (ids "media...") → metadata de adjunto (media proxy del bot)
  if (path.length === 1 && path[0]!.startsWith("media")) {
    const origin = new URL(req.url).origin;
    // 018: mime y tamaño coherentes con los bytes reales de media-file.
    return Response.json({
      id: path[0],
      mime_type: mockDeclaredMime(path[0]!),
      file_size: mockMediaBytes(path[0]!).byteLength,
      url: `${origin}/api/dev/wa-mock/media-file/${path[0]}`,
    });
  }

  // 017 — GET debug_token → validación del token de Página de Messenger.
  // Como Meta: tipo PAGE y la Página dueña sale del token (`-id<n>`).
  if (path.length === 1 && path[0] === "debug_token") {
    const input = new URL(req.url).searchParams.get("input_token") ?? "";
    const owner = ownerIdFromToken(input);
    return Response.json({
      data: {
        is_valid: true,
        type: "PAGE",
        ...(owner ? { profile_id: owner } : {}),
        scopes: ["pages_messaging", "pages_manage_metadata"],
      },
    });
  }

  // 017 — GET me → verificación del token de Instagram (graph.instagram.com,
  // que el self-test apunta aquí) y nombre de la Página en Messenger. Como
  // Meta, Instagram responde DOS ids: `id` app-scoped (distinto) y `user_id`,
  // el de la cuenta profesional, que es el que se valida.
  if (path.length === 1 && path[0] === "me") {
    const owner = ownerIdFromToken(token);
    return Response.json({
      ...(owner ? { id: `9${owner}`, user_id: owner } : {}),
      username: "vocero_prueba",
      name: "Página de prueba Vocero",
    });
  }

  // Perfil de quien escribe por Messenger ({PSID}) o Instagram ({IGSID}).
  // Un id con "sinperfil" imita el fallo de Meta (función no aprobada).
  if (path.length === 1 && /^(psid|ig)/.test(path[0]!)) {
    if (path[0]!.includes("sinperfil")) {
      return Response.json(
        { error: { message: "Missing permission", type: "OAuthException", code: 10 } },
        { status: 403 }
      );
    }
    return path[0]!.startsWith("psid")
      ? Response.json({ id: path[0], first_name: "Cliente", last_name: "Messenger" })
      : Response.json({ id: path[0], name: "Cliente Instagram", username: "cliente_ig" });
  }

  // Acceso del token a la WABA (checkWabaAccess): dueño de la WABA y usuarios
  // asignados. Un token con "noasignado" imita al usuario del sistema que lee
  // el número pero no está asignado a la cuenta (no puede enviar).
  const fields = new URL(req.url).searchParams.get("fields") ?? "";
  if (path.length === 1 && fields.includes("owner_business_info")) {
    return Response.json({ id: path[0], owner_business_info: { id: "biz-e2e" } });
  }
  if (path.length === 2 && path[1] === "assigned_users") {
    const owner = ownerIdFromToken(token);
    return Response.json({
      data:
        owner && !token.includes("noasignado")
          ? [{ id: `9${owner}`, tasks: ["MANAGE"] }]
          : [{ id: "999", tasks: ["MANAGE"] }],
    });
  }

  // GET {phoneNumberId}?fields=... → validación del wizard
  if (path.length === 1) {
    return Response.json({
      display_phone_number: "+52 55 0000 0000",
      verified_name: "Número de prueba Vocero",
      id: path[0],
    });
  }

  return Response.json({});
}

export async function POST(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // POST {phoneNumberId}/media (multipart, 008) → id de media subido.
  // Va ANTES del parseo JSON: el body es form-data.
  if (path.length === 2 && path[1] === "media") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return Response.json(
        { error: { message: "missing file", type: "GraphMethodException", code: 100 } },
        { status: 400 }
      );
    }
    // El id arranca con "media" para que el GET de metadata lo resuelva.
    const id = recordUpload(
      {
        channel: "whatsapp",
        accountId: path[0]!,
        fileName: file instanceof File ? file.name : null,
        mime: file.type || null,
        bytes: file.size,
      },
      "media-up"
    );
    return Response.json({ id });
  }

  // 019 fase B — POST {id}/message_attachments (Attachment Upload API,
  // multipart `message` + `filedata`) → `{ attachment_id }`. Messenger usa el
  // page id; Instagram (graph.instagram.com, que el self-test apunta aquí) el
  // id de la cuenta y además `platform=instagram`.
  if (path.length === 2 && path[1] === "message_attachments") {
    const form = await req.formData().catch(() => null);
    const message = parseJsonField(form?.get("message") ?? null) as {
      attachment?: { type?: string; payload?: { is_reusable?: boolean } };
    } | null;
    const file = form?.get("filedata");
    if (!message?.attachment?.type || !(file instanceof Blob)) {
      return graphParamError("(#100) message.attachment y filedata son obligatorios");
    }
    const failure = channelSendFailure(token, null);
    if (failure) return failure;
    const attachmentId = recordUpload(
      {
        channel: form?.get("platform") === "instagram" ? "instagram" : "messenger",
        accountId: path[0]!,
        fileName: file instanceof File ? file.name : null,
        mime: file.type || null,
        bytes: file.size,
        attachmentType: message.attachment.type,
        isReusable: message.attachment.payload?.is_reusable === true,
      },
      "att-up"
    );
    return Response.json({ attachment_id: attachmentId });
  }

  // 018 — POST {pageId}/messages multipart: adjunto de Messenger con
  // `filedata` (Send API). También va ANTES del parseo JSON.
  if (
    path.length === 2 &&
    path[1] === "messages" &&
    (req.headers.get("content-type") ?? "").includes("multipart/form-data")
  ) {
    const form = await req.formData().catch(() => null);
    const recipient = parseJsonField(form?.get("recipient") ?? null) as { id?: string } | null;
    const message = parseJsonField(form?.get("message") ?? null) as {
      attachment?: { type?: string };
    } | null;
    const file = form?.get("filedata");
    const tag = form?.get("tag") ?? null;
    if (!recipient?.id || !message?.attachment?.type || !(file instanceof Blob)) {
      return graphParamError("(#100) recipient, message.attachment y filedata son obligatorios");
    }
    const failure = channelSendFailure(token, tag);
    if (failure) return failure;
    const state = getWaMockState();
    const n = nextN();
    const messageId = `m_mock_${Date.now().toString(36)}_${n}`;
    state.outbox.push({
      n,
      waMessageId: messageId,
      phoneNumberId: path[0]!,
      to: recipient.id,
      type: "attachment",
      body: {
        recipient,
        message,
        messaging_type: form?.get("messaging_type") ?? null,
        tag,
      },
      attachment: {
        channel: "messenger",
        attachmentType: message.attachment.type,
        fileName: file instanceof File ? file.name : null,
        mime: file.type || null,
        bytes: file.size,
      },
      at: new Date().toISOString(),
    });
    return Response.json({ recipient_id: recipient.id, message_id: messageId });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // 016 — POST {datasetId}/events: Conversions API. Imita las tres cosas que
  // de verdad importan del endpoint real: el catálogo cerrado de nombres, la
  // exigencia del ctwa_clid, y —sobre todo— que Meta puede responder 200
  // DESCARTANDO el evento. Los datasets terminados en "-fail" reproducen eso
  // último, que es el modo de fallo que nadie ve venir.
  if (path.length === 2 && path[1] === "events") {
    const state = getWaMockState();
    const events = Array.isArray(body.data)
      ? (body.data as Record<string, unknown>[])
      : [];
    const event = events[0];
    const eventName = String(event?.event_name ?? "");
    const userData = (event?.user_data ?? {}) as Record<string, unknown>;
    const ctwaClid = userData.ctwa_clid ? String(userData.ctwa_clid) : null;

    if (!CAPI_EVENT_NAMES.has(eventName)) {
      return Response.json(
        {
          error: {
            message: `(#100) Invalid parameter: event_name ${eventName || "(vacío)"}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock-capi-badname",
          },
        },
        { status: 400 }
      );
    }
    if (!ctwaClid) {
      return Response.json(
        {
          error: {
            message: "Messaging Event Invalid Ctwa Clid",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 2804087,
            fbtrace_id: "mock-capi-noclid",
          },
        },
        { status: 400 }
      );
    }

    const datasetId = path[0]!;
    state.capiEvents.push({
      n: nextN(),
      datasetId,
      eventName,
      ctwaClid,
      customData:
        (event?.custom_data as Record<string, unknown> | undefined) ?? null,
      body,
      at: new Date().toISOString(),
    });

    // El 200 mentiroso: recibido por HTTP, descartado por Meta.
    const received = datasetId.endsWith("-fail") ? 0 : 1;
    return Response.json({
      events_received: received,
      messages: [],
      fbtrace_id: `mock-capi-${state.capiEvents.length}`,
    });
  }

  // POST {phoneNumberId}/messages con status:"read" → typing/leído:
  // NO es un mensaje saliente — no contamina el outbox.
  if (path.length === 2 && path[1] === "messages" && body.status === "read") {
    return Response.json({ success: true });
  }

  // POST {id}/messages → registra en el outbox. Mismo endpoint para WhatsApp
  // ({phoneNumberId}, `to`), Instagram ({igUserId}) y Messenger ({pageId}),
  // estos dos con `recipient.id`.
  if (path.length === 2 && path[1] === "messages") {
    const state = getWaMockState();
    const recipient = body.recipient as { id?: string } | undefined;
    // 017: Instagram/Messenger. Tokens especiales para los caminos infelices:
    // `-down` = la plataforma caída (5xx); `-nohumanagent` = la app sin la
    // función Human Agent aprobada, que Meta rechaza con un error de permiso.
    if (recipient?.id) {
      const failure = channelSendFailure(token, body.tag);
      if (failure) return failure;

      // Adjunto ya subido por `attachment_id`: Messenger (catálogo, 019 B) e
      // Instagram (siempre). Se aceptan las dos formas que admite Meta:
      // `message.attachments` (arreglo; la de imagen en Instagram) y
      // `message.attachment` (singular). Por URL ya no se envía nada.
      type MockAttachment = { type?: string; payload?: { url?: string; attachment_id?: string } };
      const msg = body.message as
        | { attachment?: MockAttachment; attachments?: MockAttachment[] }
        | undefined;
      const shape: "attachments" | "attachment" | null = Array.isArray(msg?.attachments)
        ? "attachments"
        : msg?.attachment
          ? "attachment"
          : null;
      const attachment = shape === "attachments" ? msg?.attachments?.[0] : msg?.attachment;
      if (shape === "attachments" && !attachment) {
        return graphParamError("(#100) message.attachments no puede ir vacío");
      }
      let attachmentLog: OutboxEntry["attachment"];
      const attachmentId = attachment?.payload?.attachment_id;
      if (attachment && attachmentId !== undefined) {
        if (!attachment.type || typeof attachmentId !== "string" || !attachmentId) {
          return graphParamError("(#100) attachment.type y attachment.payload.attachment_id son obligatorios");
        }
        if (isInvalidMediaId(attachmentId)) {
          return graphParamError(`(#100) Invalid attachment_id: ${attachmentId}`);
        }
        const up = state.uploads.find((u) => u.id === attachmentId);
        attachmentLog = {
          channel: up?.channel === "instagram" ? "instagram" : "messenger",
          attachmentType: attachment.type,
          attachmentId,
          shape: shape!,
          ...(up ? { fileName: up.fileName, mime: up.mime, bytes: up.bytes } : {}),
        };
      } else if (attachment) {
        // Regresión del arreglo de Instagram: en producción el descargador de
        // Meta no baja NADA de nuestro dominio (code 100, subcode 2018007). El
        // mock lo imita: un adjunto por URL falla como fallaba en Meta.
        return graphParamError("(#100) Failed to fetch the attachment from the URL (subcode 2018007)");
      }

      const n = nextN();
      const messageId = `m_mock_${Date.now().toString(36)}_${n}`;
      state.outbox.push({
        n,
        waMessageId: messageId,
        phoneNumberId: path[0]!,
        to: recipient.id,
        type: attachmentLog ? "attachment" : "text",
        body,
        ...(attachmentLog ? { attachment: attachmentLog } : {}),
        at: new Date().toISOString(),
      });
      return Response.json({ recipient_id: recipient.id, message_id: messageId });
    }
    // 10: disparador de falla conmutable (`/api/dev/wa-mock/fail-sends`) para
    // el camino infeliz de WhatsApp (p. ej. recordatorio de cita fallido).
    if (state.failSends === "down") {
      return Response.json(
        { error: { message: "Service temporarily unavailable", type: "OAuthException", code: 2, fbtrace_id: "mock" } },
        { status: 503 }
      );
    }
    if (state.failSends === "error") {
      return Response.json(
        { error: { message: "(#131026) Message undeliverable", type: "OAuthException", code: 131026, fbtrace_id: "mock" } },
        { status: 400 }
      );
    }
    // 019 fase B — Media id que Meta "ya no reconoce" (`invalidate-media`):
    // el CRM debe olvidarlo y re-subir una vez.
    const mediaRef = (body[String(body.type ?? "")] as { id?: unknown } | undefined)?.id;
    if (isInvalidMediaId(mediaRef)) {
      return Response.json(
        { error: { message: `(#131053) Media upload error: media id ${String(mediaRef)} is not valid`, type: "OAuthException", code: 131053, fbtrace_id: "mock" } },
        { status: 400 }
      );
    }
    // Meta responde 132000 si los parámetros no cuadran con las {{n}} de la
    // plantilla aprobada. El mock lo replica para que un desfase no pase.
    if (body.type === "template") {
      const tplSend = body.template as
        | {
            name?: string;
            components?: { type?: string; parameters?: unknown[] }[];
          }
        | undefined;
      const known = state.templates.find((t) => t.name === tplSend?.name);
      if (known) {
        const expected = [...known.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce(
          (max, m) => Math.max(max, Number(m[1])),
          0
        );
        const got =
          tplSend?.components?.find(
            (c) => (c.type ?? "").toLowerCase() === "body"
          )?.parameters?.length ?? 0;
        if (expected !== got) {
          return Response.json(
            {
              error: {
                message: `(#132000) Number of parameters does not match the expected number of params: expected ${expected}, got ${got}`,
                type: "OAuthException",
                code: 132000,
                fbtrace_id: "mock",
              },
            },
            { status: 400 }
          );
        }
      }
    }
    const n = nextN();
    const waMessageId = nextOutboundWamid();
    state.outbox.push({
      n,
      waMessageId,
      phoneNumberId: path[0]!,
      to: String(body.to ?? ""),
      type: String(body.type ?? "text"),
      body,
      at: new Date().toISOString(),
    });
    return Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: body.to, wa_id: body.to }],
      messages: [{ id: waMessageId }],
    });
  }

  // POST {wabaId}/message_templates → alta de plantilla (queda PENDING)
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    const components = (body.components ?? []) as {
      type?: string;
      text?: string;
      example?: { body_text?: string[][] };
    }[];
    const bodyComponent = components.find(
      (c) => (c.type ?? "").toUpperCase() === "BODY"
    );
    // Meta valida que haya un ejemplo por cada {{n}} del cuerpo: sin esto el
    // mock aceptaría plantillas que producción rechaza (error 100).
    const highestVar = [
      ...(bodyComponent?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g),
    ].reduce((max, m) => Math.max(max, Number(m[1])), 0);
    const examples = bodyComponent?.example?.body_text?.[0] ?? [];
    if (highestVar !== examples.length) {
      return Response.json(
        {
          error: {
            message: `Invalid parameter: expected ${highestVar} example value(s) for the body, got ${examples.length}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock",
          },
        },
        { status: 400 }
      );
    }
    const tpl: MockTemplate = {
      id: `tplmock_${nextN()}`,
      name: String(body.name ?? ""),
      language: String(body.language ?? "es_MX"),
      category: String(body.category ?? "UTILITY"),
      status: "PENDING",
      body: bodyComponent?.text ?? "",
      components,
    };
    state.templates.push(tpl);
    return Response.json({ id: tpl.id, status: "PENDING", category: tpl.category });
  }

  // POST {wabaId}/subscribed_apps → suscripción (con o sin override)
  if (path.length === 2 && path[1] === "subscribed_apps") {
    // 020 fase C: se anota lo pedido para que el self-test lo afirme.
    const fields = Array.isArray(body.subscribed_fields)
      ? body.subscribed_fields.map(String)
      : null;
    // Meta rechaza suscribir con un token sin acceso a la WABA. Un token con
    // "sinreferrals" imita a una Página que acepta `messages` pero rechaza
    // los campos del origen de anuncios (020 fase C).
    const rejected =
      token.includes("noasignado") ||
      token.includes("nosuscribe") ||
      (token.includes("sinreferrals") && (fields ?? []).some((f) => f !== "messages"));
    getWaMockState().subscriptions.push({
      accountId: path[0]!,
      fields,
      accepted: !rejected,
      at: new Date().toISOString(),
    });
    if (rejected) {
      return Response.json(
        { error: { message: "(#200) Permissions error", type: "OAuthException", code: 200 } },
        { status: 403 }
      );
    }
    return Response.json({ success: true });
  }

  return Response.json({});
}

export async function DELETE(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();
  await ctx.params;
  return Response.json({ success: true });
}
