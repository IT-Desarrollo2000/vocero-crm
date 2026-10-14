import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-807, FR-809) — Adjuntos entrantes de Messenger e Instagram (Meta):
 * un mensaje por adjunto (`mid`, `mid#1`…), el texto como pie del primero,
 * los tipos no soportados como marcador legible y nunca un mensaje vacío.
 * Zernio: adjunto sin texto → "[Adjunto no soportado]".
 */

const { ingestInboundMessage, ingestInboundBatch } = vi.hoisted(() => {
  const ingestInboundMessage = vi.fn();
  // El lote real (`ingestInboundBatch`) se prueba en ingest-batch.test.ts;
  // aquí solo reenvía cada ítem para observar qué se ingiere.
  const ingestInboundBatch = vi.fn(async (items: unknown[]) => {
    for (const item of items) await ingestInboundMessage(item);
  });
  return { ingestInboundMessage, ingestInboundBatch };
});

vi.mock("@/server/inbox/ingest", () => ({ ingestInboundMessage, ingestInboundBatch }));
vi.mock("@/server/channels/profile", () => ({
  resolveChannelProfileName: async () => "Cliente",
}));
vi.mock("@/server/messenger/credentials", () => ({
  getMessengerCredentialsByPageId: async () => ({
    organizationId: "org_1",
    token: "t",
    pageId: "page_1",
  }),
}));
vi.mock("@/server/instagram/credentials", () => ({
  getInstagramCredentialsByIgUserId: async () => ({
    organizationId: "org_1",
    source: "meta",
    token: "t",
    igUserId: "ig_1",
  }),
  getInstagramCredentialsByAccountRef: async () => ({
    organizationId: "org_1",
    source: "zernio",
    token: "t",
  }),
}));

const {
  fileNameFromUrl,
  metaInboundItems,
  unsupportedAttachmentMarker,
} = await import("@/server/channels/meta-attachments");
const { processMessengerPayload } = await import("@/server/messenger/ingest");
const { processMetaInstagramPayload, processZernioEvent, zernioInboundText } = await import(
  "@/server/instagram/ingest"
);

const CDN = "https://scontent.xx.fbcdn.net/v/t1/";

describe("metaInboundItems — reglas puras", () => {
  it("solo texto → un mensaje de texto", () => {
    expect(metaInboundItems({ text: "hola" })).toEqual([
      { idSuffix: "", type: "text", text: "hola", media: null },
    ]);
  });

  it("varios adjuntos → uno por adjunto; el texto es el pie del PRIMERO", () => {
    const items = metaInboundItems({
      text: "¿tienen este?",
      attachments: [
        { type: "image", payload: { url: `${CDN}a.jpg` } },
        { type: "video", payload: { url: `${CDN}b.mp4` } },
        { type: "file", payload: { url: `${CDN}cotizaci%C3%B3n.pdf?oh=x` } },
        { type: "audio", payload: { url: `${CDN}nota.mp4` } },
      ],
    });
    expect(items.map((i) => [i.idSuffix, i.type, i.text])).toEqual([
      ["", "image", null],
      ["#1", "video", null],
      ["#2", "document", null],
      ["#3", "audio", null],
    ]);
    expect(items[0]?.media).toMatchObject({
      kind: "image",
      sourceUrl: `${CDN}a.jpg`,
      caption: "¿tienen este?",
      mimeType: null,
      waMediaId: null,
      fetchStatus: "pending",
    });
    expect(items[1]?.media?.caption).toBeNull();
    // file → document, con el nombre que trae la URL (saneado).
    expect(items[2]?.media).toMatchObject({ kind: "document", fileName: "cotización.pdf" });
  });

  it("no soportado sin texto → marcador legible, nunca vacío", () => {
    expect(
      metaInboundItems({ attachments: [{ type: "story_mention", payload: { url: `${CDN}s` } }] })
    ).toEqual([
      {
        idSuffix: "",
        type: "text",
        text: "[Adjunto no soportado: mención en una historia]",
        media: null,
      },
    ]);
  });

  it("no soportado CON texto → el texto entra y el marcador va al final", () => {
    expect(
      metaInboundItems({ text: "mira este reel", attachments: [{ type: "ig_reel", payload: {} }] })
    ).toEqual([
      {
        idSuffix: "",
        type: "text",
        text: "mira este reel [Adjunto no soportado: reel]",
        media: null,
      },
    ]);
  });

  it("sticker sin url, imagen sin url y tipos desconocidos → marcador; nunca el string crudo", () => {
    const [item] = metaInboundItems({
      attachments: [
        { type: "sticker", payload: { sticker_id: 1 } },
        { type: "image", payload: {} },
        { type: "<script>evil</script>", payload: { url: `${CDN}x` } },
      ],
    });
    expect(item?.text).toBe(
      "[Adjunto no soportado: sticker] [Adjunto no soportado: imagen sin enlace] [Adjunto no soportado: tipo desconocido]"
    );
    expect(item?.text).not.toContain("script");
    expect(unsupportedAttachmentMarker("toString")).toBe(
      "[Adjunto no soportado: tipo desconocido]"
    );
  });

  it("mixto (soportado + no soportado) → los marcadores en un texto al final de la secuencia", () => {
    const items = metaInboundItems({
      attachments: [
        { type: "image", payload: { url: `${CDN}a.jpg` } },
        { type: "share", payload: { url: "https://example.com" } },
      ],
    });
    expect(items.map((i) => [i.idSuffix, i.type, i.text])).toEqual([
      ["", "image", null],
      ["#1", "text", "[Adjunto no soportado: publicación compartida]"],
    ]);
  });

  it("sin texto ni adjuntos → nada", () => {
    expect(metaInboundItems({})).toEqual([]);
    expect(metaInboundItems({ text: "", attachments: [] })).toEqual([]);
    expect(metaInboundItems({ attachments: "basura" })).toEqual([]);
  });

  it("fileNameFromUrl: solo nombres con extensión, saneados", () => {
    expect(fileNameFromUrl("https://cdn.fbsbx.com/v/t59/factura.pdf?dl=1")).toBe("factura.pdf");
    expect(fileNameFromUrl("https://cdn.fbsbx.com/v/t59/123456")).toBeNull();
    expect(fileNameFromUrl("https://cdn.fbsbx.com/v/..%2F..%2Fetc%2Fpasswd.txt")).toBe(
      "_.._etc_passwd.txt"
    );
    expect(fileNameFromUrl("no es url")).toBeNull();
  });
});

describe("ingesta Messenger / Instagram (Meta) con adjuntos", () => {
  beforeEach(() => {
    ingestInboundMessage.mockReset();
    ingestInboundBatch.mockClear();
  });

  const messaging = (message: Record<string, unknown>) => [
    { sender: { id: "psid_1" }, recipient: { id: "acct" }, timestamp: 1_700_000_000_000, message },
  ];

  it("Messenger: fb_<mid> para el primero, fb_<mid>#1 para el segundo; source_url pasa a la ingesta", async () => {
    await processMessengerPayload({
      object: "page",
      entry: [
        {
          id: "page_1",
          messaging: messaging({
            mid: "m_1",
            text: "las fotos",
            attachments: [
              { type: "image", payload: { url: `${CDN}a.jpg` } },
              { type: "image", payload: { url: `${CDN}b.jpg` } },
            ],
          }),
        },
      ],
    });
    // Los dos adjuntos del MISMO mid van en un solo lote (→ un turno del agente).
    expect(ingestInboundBatch).toHaveBeenCalledTimes(1);
    expect(ingestInboundBatch.mock.calls[0]?.[0]).toHaveLength(2);
    const calls = ingestInboundMessage.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      organizationId: "org_1",
      waMessageId: "fb_m_1",
      type: "image",
      text: null,
      timestamp: "1700000000",
      media: { kind: "image", sourceUrl: `${CDN}a.jpg`, caption: "las fotos" },
      identity: { identity: "fb:psid_1", channel: "messenger" },
    });
    expect(calls[1]).toMatchObject({
      waMessageId: "fb_m_1#1",
      media: { sourceUrl: `${CDN}b.jpg`, caption: null },
    });
  });

  it("Instagram: story_mention sin texto entra como marcador (antes se perdía)", async () => {
    await processMetaInstagramPayload({
      object: "instagram",
      entry: [
        {
          id: "ig_1",
          messaging: messaging({
            mid: "m_9",
            attachments: [{ type: "story_mention", payload: { url: `${CDN}s` } }],
          }),
        },
      ],
    });
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      waMessageId: "ig_m_9",
      type: "text",
      text: "[Adjunto no soportado: mención en una historia]",
      media: null,
    });
  });

  it("Instagram: PDF entrante → document con source_url; un eco no entra", async () => {
    await processMetaInstagramPayload({
      object: "instagram",
      entry: [
        {
          id: "ig_1",
          messaging: [
            ...messaging({
              mid: "m_10",
              attachments: [{ type: "file", payload: { url: `${CDN}c.pdf` } }],
            }),
            ...messaging({ mid: "m_11", text: "eco", is_echo: true }),
          ],
        },
      ],
    });
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      waMessageId: "ig_m_10",
      type: "document",
      media: { kind: "document", sourceUrl: `${CDN}c.pdf`, fileName: "c.pdf" },
    });
  });
});

describe("Zernio (FR-809)", () => {
  beforeEach(() => {
    ingestInboundMessage.mockReset();
    ingestInboundBatch.mockClear();
  });

  it("zernioInboundText: adjunto sin texto → marcador; con texto, al final; sin nada → igual que antes", () => {
    expect(zernioInboundText({ text: null, attachments: [{ type: "image" }] })).toBe(
      "[Adjunto no soportado]"
    );
    expect(zernioInboundText({ text: "", media: { url: "x" } })).toBe("[Adjunto no soportado]");
    expect(zernioInboundText({ text: "hola", attachments: [{}] })).toBe(
      "hola [Adjunto no soportado]"
    );
    expect(zernioInboundText({ text: "hola", attachments: [] })).toBe("hola");
    expect(zernioInboundText({ text: null })).toBeNull();
  });

  it("un evento con adjunto y sin texto se ingiere con el marcador", async () => {
    await processZernioEvent({
      event: "message.received",
      account: { id: "acc_1", platform: "instagram" },
      message: {
        id: "zm_1",
        direction: "incoming",
        text: null,
        sender: { id: "igsid_1" },
        attachments: [{ type: "image", url: "https://zernio.example/x.jpg" }],
      },
    });
    expect(ingestInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      waMessageId: "ig_zm_1",
      type: "text",
      text: "[Adjunto no soportado]",
    });
  });
});
