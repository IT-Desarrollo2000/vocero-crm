import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 019 fase B (FR-942/943/944) — Reutilización de lo ya subido a Meta para los
 * archivos del catálogo. La caché (`remote-cache.ts`) se sustituye por un
 * Map en memoria; Graph se imita con `fetch`, así se cuentan las subidas
 * reales (`/media`, `/message_attachments`) y los envíos (`/messages`).
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const KEY = Buffer.alloc(32, 3).toString("base64");

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const k = (key: { productFileId: string; channel: string; accountId: string }) =>
    `${key.productFileId}|${key.channel}|${key.accountId}`;
  return {
    store,
    getReusableRemoteId: vi.fn(async (key: Parameters<typeof k>[0]) => store.get(k(key)) ?? null),
    saveRemoteId: vi.fn(async (key: Parameters<typeof k>[0] & { remoteId: string }) => {
      store.set(k(key), key.remoteId);
    }),
    forgetRemoteId: vi.fn(async (key: Parameters<typeof k>[0]) => {
      store.delete(k(key));
    }),
    saveMediaFile: vi.fn(async () => "org_1/ma_x"),
    markReconnectRequired: vi.fn(async () => {}),
    getMessengerCredentialsByOrg: vi.fn(),
    publish: vi.fn(),
    selectRows: [] as unknown[][],
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
  };
});

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
vi.mock("@/server/catalog/remote-cache", () => ({
  getReusableRemoteId: h.getReusableRemoteId,
  saveRemoteId: h.saveRemoteId,
  forgetRemoteId: h.forgetRemoteId,
}));
vi.mock("@/server/whatsapp/media", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/whatsapp/media")>();
  return { ...original, saveMediaFile: h.saveMediaFile };
});
vi.mock("@/server/whatsapp/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/whatsapp/credentials")>();
  return {
    ...original,
    getCredentialsByOrg: async () => ({
      organizationId: "org_1",
      status: "connected",
      token: "wa-token",
      phoneNumberId: "pn_1",
    }),
    markReconnectRequired: h.markReconnectRequired,
  };
});
vi.mock("@/server/messenger/credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/messenger/credentials")>();
  return {
    ...original,
    getMessengerCredentialsByOrg: h.getMessengerCredentialsByOrg,
    markMessengerReconnectRequired: vi.fn(async () => {}),
  };
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

function conversation(
  channel: "whatsapp" | "messenger",
  over: Record<string, unknown> = {}
) {
  return [
    {
      conversation: {
        id: "cv_1",
        organizationId: "org_1",
        isTest: false,
        channel,
        lastInboundAt: new Date(),
        channelThreadRef: null,
        ...over,
      },
      contact: {
        id: "ct_1",
        phone: channel === "whatsapp" ? "5215511111111" : null,
        waIdentity: channel === "whatsapp" ? "525511111111" : "fb:psid_1",
        waUserId: null,
      },
    },
  ];
}

const fetchMock = vi.fn();
let uploadN = 0;

/** Graph imitado: sube, envía; `reject` decide qué `/messages` falla. */
function graph(reject: (body: Record<string, unknown>) => Response | null = () => null) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/media")) return Response.json({ id: `media-up-${++uploadN}` });
    if (url.endsWith("/message_attachments")) {
      return Response.json({ attachment_id: `att-up-${++uploadN}` });
    }
    if (url.endsWith("/messages")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const failure = reject(body);
      if (failure) return failure;
      return body.recipient
        ? Response.json({ recipient_id: "psid_1", message_id: `mid.${uploadN}` })
        : Response.json({ messages: [{ id: `wamid.out.${uploadN}` }] });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
}

const calls = (suffix: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const sentBodies = () =>
  calls("/messages").map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
const messageInserts = () => h.inserts.filter((v) => "direction" in v && "conversationId" in v);
const assetInserts = () => h.inserts.filter((v) => "storagePath" in v);

const metaError = (status: number, code: number) =>
  Response.json({ error: { message: `mock ${code}`, type: "OAuthException", code } }, { status });

function sendCatalog(productFileId: string | null = "pf_1") {
  return sendMediaMessage({
    conversationId: "cv_1",
    organizationId: "org_1",
    file: { data: JPEG, mimeType: "image/jpeg", fileName: "frente.jpg" },
    ...(productFileId ? { productFileId } : {}),
  });
}

beforeEach(() => {
  h.store.clear();
  h.selectRows.length = 0;
  h.inserts.length = 0;
  h.updates.length = 0;
  h.getReusableRemoteId.mockClear();
  h.saveRemoteId.mockClear();
  h.forgetRemoteId.mockClear();
  h.markReconnectRequired.mockClear();
  h.saveMediaFile.mockClear();
  uploadN = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  h.getMessengerCredentialsByOrg.mockResolvedValue({
    organizationId: "org_1",
    status: "connected",
    token: "page-token",
    pageId: "page_1",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp — reutilización del media id (FR-942)", () => {
  it("1er envío sube y guarda; 2º envío reutiliza el id sin llamar a /media", async () => {
    graph();
    h.selectRows.push(conversation("whatsapp"));
    await sendCatalog();
    expect(calls("/media")).toHaveLength(1);
    expect(h.saveRemoteId).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        productFileId: "pf_1",
        channel: "whatsapp",
        accountId: "pn_1",
        remoteId: "media-up-1",
      })
    );

    h.selectRows.push(conversation("whatsapp"));
    await sendCatalog();
    expect(calls("/media")).toHaveLength(1); // 0 subidas nuevas
    expect(h.saveRemoteId).toHaveBeenCalledTimes(1); // reutilizar no refresca uploaded_at
    const second = sentBodies()[1] as { image?: { id?: string } };
    expect(second.image?.id).toBe("media-up-1");

    // El hilo se ve igual: copia en media_asset con procedencia y wa_media_id.
    expect(assetInserts()).toHaveLength(2);
    expect(assetInserts().every((a) => a.productFileId === "pf_1")).toBe(true);
    expect(h.updates.filter((u) => u.waMediaId === "media-up-1")).toHaveLength(2);
    expect(messageInserts().map((m) => m.status)).toEqual(["pending", "pending"]);
  });

  it("id rechazado con 4xx no-auth → olvida, re-sube UNA vez, envía y guarda el nuevo", async () => {
    h.store.set("pf_1|whatsapp|pn_1", "media-viejo");
    graph((body) =>
      (body.image as { id?: string }).id === "media-viejo" ? metaError(400, 131053) : null
    );
    h.selectRows.push(conversation("whatsapp"));
    const r = await sendCatalog();
    expect(r.messageId).toBeTruthy();
    expect(h.forgetRemoteId).toHaveBeenCalledTimes(1);
    expect(calls("/media")).toHaveLength(1);
    expect(calls("/messages")).toHaveLength(2);
    expect(h.saveRemoteId).toHaveBeenCalledWith(expect.objectContaining({ remoteId: "media-up-1" }));
    expect(h.store.get("pf_1|whatsapp|pn_1")).toBe("media-up-1");
    expect(messageInserts()).toHaveLength(1);
    expect(messageInserts()[0]!.status).toBe("pending");
  });

  it("si el id recién subido también falla, no hay segunda re-subida", async () => {
    h.store.set("pf_1|whatsapp|pn_1", "media-viejo");
    graph(() => metaError(400, 131053));
    h.selectRows.push(conversation("whatsapp"));
    await expect(sendCatalog()).rejects.toMatchObject({ code: "meta_error" });
    expect(calls("/media")).toHaveLength(1);
    expect(calls("/messages")).toHaveLength(2);
    expect(messageInserts()[0]!.status).toBe("failed");
  });

  it("auth (401/190) con el id cacheado → reconnect_required, sin re-subir ni olvidar", async () => {
    h.store.set("pf_1|whatsapp|pn_1", "media-viejo");
    graph(() => metaError(401, 190));
    h.selectRows.push(conversation("whatsapp"));
    await expect(sendCatalog()).rejects.toMatchObject({ code: "reconnect_required" });
    expect(h.markReconnectRequired).toHaveBeenCalled();
    expect(calls("/media")).toHaveLength(0);
    expect(h.forgetRemoteId).not.toHaveBeenCalled();
  });

  it("5xx con el id cacheado → meta_unavailable, sin re-subir ni olvidar", async () => {
    h.store.set("pf_1|whatsapp|pn_1", "media-viejo");
    graph(() => metaError(503, 2));
    h.selectRows.push(conversation("whatsapp"));
    await expect(sendCatalog()).rejects.toMatchObject({ code: "meta_unavailable" });
    expect(calls("/media")).toHaveLength(0);
    expect(h.forgetRemoteId).not.toHaveBeenCalled();
    expect(h.store.get("pf_1|whatsapp|pn_1")).toBe("media-viejo");
  });

  it("un fallo de la caché (BD) degrada a subir como siempre", async () => {
    graph();
    h.getReusableRemoteId.mockRejectedValueOnce(new Error("db caída"));
    h.saveRemoteId.mockRejectedValueOnce(new Error("db caída"));
    h.selectRows.push(conversation("whatsapp"));
    const r = await sendCatalog();
    expect(r.messageId).toBeTruthy();
    expect(calls("/media")).toHaveLength(1);
  });

  it("adjunto suelto (sin productFileId) no consulta ni escribe la caché", async () => {
    graph();
    h.selectRows.push(conversation("whatsapp"));
    await sendCatalog(null);
    h.selectRows.push(conversation("whatsapp"));
    await sendCatalog(null);
    expect(calls("/media")).toHaveLength(2);
    expect(h.getReusableRemoteId).not.toHaveBeenCalled();
    expect(h.saveRemoteId).not.toHaveBeenCalled();
  });
});

describe("Messenger — attachment_id reutilizable (FR-943)", () => {
  it("1ª vez: message_attachments (is_reusable:true) + /messages con attachment_id; 2ª: 0 subidas", async () => {
    graph();
    h.selectRows.push(conversation("messenger"));
    const r1 = await sendCatalog();
    expect(r1.messageId).toBeTruthy();

    const [url, init] = calls("/message_attachments")[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.test/v25.0/page_1/message_attachments");
    const form = init.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({
      attachment: { type: "image", payload: { is_reusable: true } },
    });
    expect((form.get("filedata") as File).size).toBe(JPEG.byteLength);
    expect(sentBodies()[0]).toEqual({
      recipient: { id: "psid_1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { attachment_id: "att-up-1" } } },
    });
    expect(h.saveRemoteId).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "messenger", accountId: "page_1", remoteId: "att-up-1" })
    );
    expect(messageInserts()[0]!.waMessageId).toBe("fb_mid.1");

    h.selectRows.push(conversation("messenger"));
    await sendCatalog();
    expect(calls("/message_attachments")).toHaveLength(1);
    expect(calls("/messages")).toHaveLength(2);
    expect(assetInserts()).toHaveLength(2);
  });

  it("attachment_id rechazado (400 code 100) → re-sube una vez y guarda el nuevo", async () => {
    h.store.set("pf_1|messenger|page_1", "att-viejo");
    graph((body) =>
      JSON.stringify(body).includes("att-viejo") ? metaError(400, 100) : null
    );
    h.selectRows.push(conversation("messenger"));
    await sendCatalog();
    expect(h.forgetRemoteId).toHaveBeenCalledTimes(1);
    expect(calls("/message_attachments")).toHaveLength(1);
    expect(h.store.get("pf_1|messenger|page_1")).toBe("att-up-1");
  });

  it("adjunto suelto por Messenger sigue el multipart directo (is_reusable:false)", async () => {
    fetchMock.mockResolvedValue(Response.json({ recipient_id: "psid_1", message_id: "mid.x" }));
    h.selectRows.push(conversation("messenger"));
    await sendCatalog(null);
    expect(calls("/message_attachments")).toHaveLength(0);
    const form = (calls("/messages")[0]![1] as RequestInit).body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({
      attachment: { type: "image", payload: { is_reusable: false } },
    });
    expect(h.getReusableRemoteId).not.toHaveBeenCalled();
  });
});

describe("Sandbox del Laboratorio (FR-944)", () => {
  it("is_test con productFileId → sandbox_violation sin tocar Meta NI la caché", async () => {
    h.store.set("pf_1|whatsapp|pn_1", "media-viejo");
    graph();
    for (const channel of ["whatsapp", "messenger"] as const) {
      h.selectRows.push(conversation(channel, { isTest: true }));
      await expect(sendCatalog()).rejects.toMatchObject({ code: "sandbox_violation" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.getReusableRemoteId).not.toHaveBeenCalled();
    expect(h.saveRemoteId).not.toHaveBeenCalled();
    expect(h.forgetRemoteId).not.toHaveBeenCalled();
    expect(h.saveMediaFile).not.toHaveBeenCalled();
  });
});
