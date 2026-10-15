import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-810, FR-811) — Salida de archivos por Messenger (multipart con
 * `filedata`) e Instagram (Meta: URL firmada del CRM). Ninguno de los dos
 * tiene pie en los adjuntos: el caption sale DESPUÉS como texto aparte, y si
 * ese texto falla el adjunto ya cuenta como enviado. Instagram vía Zernio no
 * envía archivos (415 antes de tocar disco).
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF");
const KEY = Buffer.alloc(32, 3).toString("base64");

const h = vi.hoisted(() => ({
  saveMediaFile: vi.fn(async () => "org_1/ma_x"),
  getInstagramCredentialsByOrg: vi.fn(),
  getMessengerCredentialsByOrg: vi.fn(),
  publish: vi.fn(),
  selectRows: [] as unknown[][],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...original,
    getEnv: () => ({
      APP_BASE_URL: "https://crm.example.com",
      ENCRYPTION_KEY: KEY,
      META_GRAPH_BASE_URL: "https://graph.facebook.test",
      META_GRAPH_API_VERSION: "v25.0",
      MEDIA_DIR: "/data/media",
    }),
  };
});
vi.mock("@/server/whatsapp/media", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/whatsapp/media")>();
  return { ...original, saveMediaFile: h.saveMediaFile };
});
vi.mock("@/server/instagram/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/instagram/credentials")>();
  return { ...original, getInstagramCredentialsByOrg: h.getInstagramCredentialsByOrg };
});
vi.mock("@/server/messenger/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/messenger/credentials")>();
  return { ...original, getMessengerCredentialsByOrg: h.getMessengerCredentialsByOrg };
});
vi.mock("@/server/channels/enabled", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/channels/enabled")>();
  return { ...original, isChannelEnabled: () => true };
});
vi.mock("@/server/events/bus", () => ({ publish: h.publish }));

vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "orderBy"]) c[m] = () => c;
    c.limit = () => Promise.resolve(rows);
    return c;
  };
  return {
    getDb: () => ({
      select: () => chain(h.selectRows.shift() ?? []),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return { returning: async () => [{ createdAt: new Date(), ...v }] };
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          h.updates.push(v);
          return { where: async () => [] };
        },
      }),
    }),
    schema: {
      conversation: { contactId: "contactId", id: "id" },
      contact: { id: "id" },
      message: {},
      mediaAsset: { id: "id" },
    },
  };
});

const { sendMediaMessage } = await import("@/server/inbox/send");
const { verifyMediaToken } = await import("@/server/media/signed-url");

function conversation(channel: "instagram" | "messenger", waIdentity: string) {
  return [
    {
      conversation: {
        id: "cv_1",
        organizationId: "org_1",
        isTest: false,
        channel,
        lastInboundAt: new Date(),
        channelThreadRef: null,
      },
      contact: { id: "ct_1", phone: null, waIdentity },
    },
  ];
}

const fetchMock = vi.fn();
const messageInserts = () => h.inserts.filter((v) => "direction" in v && "conversationId" in v);

beforeEach(() => {
  h.selectRows.length = 0;
  h.inserts.length = 0;
  h.updates.length = 0;
  h.saveMediaFile.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  h.getMessengerCredentialsByOrg.mockResolvedValue({
    organizationId: "org_1",
    status: "connected",
    token: "page-token",
    pageId: "page_1",
  });
  h.getInstagramCredentialsByOrg.mockResolvedValue({
    organizationId: "org_1",
    status: "connected",
    source: "meta",
    token: "ig-token",
    igUserId: "igu_1",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Messenger — multipart con filedata", () => {
  it("POST {pageId}/messages con recipient, message.attachment, messaging_type y filedata", async () => {
    fetchMock.mockResolvedValue(Response.json({ recipient_id: "psid_1", message_id: "mid.1" }));
    h.selectRows.push(conversation("messenger", "fb:psid_1"));

    const r = await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: PDF, mimeType: "application/pdf", fileName: "cotizacion.pdf" },
    });
    expect(r.messageId).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.test/v25.0/page_1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer page-token");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("recipient")))).toEqual({ id: "psid_1" });
    expect(JSON.parse(String(form.get("message")))).toEqual({
      attachment: { type: "file", payload: { is_reusable: false } },
    });
    expect(form.get("messaging_type")).toBe("RESPONSE");
    expect(form.get("tag")).toBeNull();
    const file = form.get("filedata") as File;
    expect(file.name).toBe("cotizacion.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(PDF.byteLength);

    // Persistido con el id prefijado y el asset saliente.
    expect(messageInserts()[0]).toMatchObject({ waMessageId: "fb_mid.1", type: "document", status: "sent" });
    expect(h.inserts.find((v) => v.kind === "document")).toMatchObject({
      direction: "out",
      productFileId: null,
    });
  });

  it("019 (FR-940): la copia guarda productFileId como procedencia", async () => {
    fetchMock.mockResolvedValue(Response.json({ recipient_id: "psid_1", message_id: "mid.9" }));
    h.selectRows.push(conversation("messenger", "fb:psid_1"));

    await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: PDF, mimeType: "application/pdf", fileName: "ficha.pdf" },
      productFileId: "pf_1",
    });

    expect(h.inserts.find((v) => v.kind === "document")).toMatchObject({
      direction: "out",
      productFileId: "pf_1",
    });
  });

  it("fuera de las 24 h sale con MESSAGE_TAG + HUMAN_AGENT", async () => {
    fetchMock.mockResolvedValue(Response.json({ message_id: "mid.2" }));
    const row = conversation("messenger", "fb:psid_1");
    row[0]!.conversation.lastInboundAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
    h.selectRows.push(row);
    await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: JPEG, mimeType: "image/jpeg", fileName: "foto.jpg" },
    });
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get("messaging_type")).toBe("MESSAGE_TAG");
    expect(form.get("tag")).toBe("HUMAN_AGENT");
    expect(JSON.parse(String(form.get("message"))).attachment.type).toBe("image");
  });

  it("caption → el adjunto primero y DESPUÉS un texto aparte, persistido como suyo", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ message_id: "mid.att" }))
      .mockResolvedValueOnce(Response.json({ message_id: "mid.txt" }));
    h.selectRows.push(conversation("messenger", "fb:psid_1"), conversation("messenger", "fb:psid_1"));

    await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: JPEG, mimeType: "image/jpeg", fileName: "foto.jpg" },
      caption: "Esta es la cotización",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const textBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(textBody).toMatchObject({ recipient: { id: "psid_1" }, message: { text: "Esta es la cotización" } });
    expect(messageInserts().map((m) => [m.waMessageId, m.type, m.text, m.origin])).toEqual([
      ["fb_mid.att", "image", null, "operator"],
      ["fb_mid.txt", "text", "Esta es la cotización", "operator"],
    ]);
    // La tarjeta no repite el pie: viaja como su propio mensaje.
    expect(h.inserts.find((v) => v.kind === "image")?.caption).toBeNull();
  });

  it("si el texto del pie falla, el adjunto ya salió: éxito y el pie queda FAILED en el hilo con su motivo", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ message_id: "mid.att" }))
      .mockResolvedValueOnce(Response.json({ error: { message: "boom", code: 1 } }, { status: 400 }));
    h.selectRows.push(conversation("messenger", "fb:psid_1"), conversation("messenger", "fb:psid_1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: JPEG, mimeType: "image/jpeg", fileName: "foto.jpg" },
      caption: "pie",
    });
    expect(r.messageId).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // El adjunto `sent`; el pie, su propio mensaje `failed`, con texto y motivo.
    const rows = messageInserts();
    expect(rows.map((m) => [m.type, m.status, m.text])).toEqual([
      ["image", "sent", null],
      ["text", "failed", "pie"],
    ]);
    expect(r.messageId).toBe(rows[0]?.id);
    expect(String(rows[1]?.error)).toMatch(/El archivo sí se envió, pero su texto no/);
    expect(rows[1]?.origin).toBe("operator");
  });

  it("si el adjunto falla, el mensaje queda failed y CONSERVA el pie", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "caído", code: 2 } }, { status: 503 })
    );
    h.selectRows.push(conversation("messenger", "fb:psid_1"));
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: { data: JPEG, mimeType: "image/jpeg", fileName: "foto.jpg" },
        caption: "pie",
      })
    ).rejects.toMatchObject({ code: "meta_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messageInserts().map((m) => m.status)).toEqual(["failed"]);
    expect(h.updates).toContainEqual(expect.objectContaining({ caption: "pie" }));
  });
});

describe("Instagram (Meta) — por URL firmada", () => {
  it("manda attachment.payload.url = URL firmada de ESE asset; PDF sale como file", async () => {
    fetchMock.mockResolvedValue(Response.json({ recipient_id: "igsid_1", message_id: "igm.1" }));
    h.selectRows.push(conversation("instagram", "ig:igsid_1"));

    await sendMediaMessage({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: PDF, mimeType: "application/pdf", fileName: "c.pdf" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/igu_1\/messages$/);
    const body = JSON.parse(String(init.body));
    expect(body.recipient).toEqual({ id: "igsid_1" });
    expect(body.message.attachment.type).toBe("file");
    const signed: string = body.message.attachment.payload.url;
    expect(signed).toMatch(/^https:\/\/crm\.example\.com\/api\/media\/out\//);
    const claims = verifyMediaToken(signed.split("/").pop()!);
    const asset = h.inserts.find((v) => v.kind === "document");
    expect(claims).toEqual({ organizationId: "org_1", assetId: asset?.id });
    expect(asset).toMatchObject({ direction: "out" });
    expect(messageInserts()[0]).toMatchObject({ waMessageId: "ig_igm.1", status: "sent" });
  });

  it("Zernio → 415 'no permite enviar archivos' antes de disco y red", async () => {
    h.getInstagramCredentialsByOrg.mockResolvedValue({
      organizationId: "org_1",
      status: "connected",
      source: "zernio",
      token: "z",
      igUserId: "igu_1",
    });
    h.selectRows.push(conversation("instagram", "ig:igsid_1"));
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: { data: JPEG, mimeType: "image/jpeg", fileName: "foto.jpg" },
      })
    ).rejects.toMatchObject({ code: "unsupported_type" });
    expect(h.saveMediaFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
