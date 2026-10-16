import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDocx } from "./helpers/zip";

/**
 * 008/018 — Envío de adjuntos: la validación (tope → firma → canal) ocurre
 * ANTES de tocar disco o la API, y el sandbox del Laboratorio sigue siendo
 * infranqueable también para adjuntos (FR-014). La política de archivos en
 * sí se prueba en `file-policy.test.ts`.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF");

const { graphRequest, uploadGraphMedia, saveMediaFile, getInstagramCredentialsByOrg } =
  vi.hoisted(() => ({
    graphRequest: vi.fn(),
    uploadGraphMedia: vi.fn(),
    saveMediaFile: vi.fn(),
    getInstagramCredentialsByOrg: vi.fn(),
  }));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

vi.mock("@/server/whatsapp/media", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/whatsapp/media")>();
  return { ...original, uploadGraphMedia, saveMediaFile };
});

vi.mock("@/server/instagram/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/instagram/credentials")>();
  return { ...original, getInstagramCredentialsByOrg };
});

vi.mock("@/server/whatsapp/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/whatsapp/credentials")>();
  return {
    ...original,
    getCredentialsByOrg: async () => ({
      organizationId: "org_1",
      status: "connected",
      token: "t",
      phoneNumberId: "pn_1",
    }),
  };
});

vi.mock("@/server/channels/enabled", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/channels/enabled")>();
  return { ...original, isChannelEnabled: () => true };
});

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy"]) {
    chain[m] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

const selectRows: unknown[][] = [];
const selectCalls = { n: 0 };

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => {
      selectCalls.n++;
      return makeChain(selectRows.shift() ?? []);
    },
  }),
  schema: {
    conversation: { contactId: "contactId", id: "id" },
    contact: { id: "id" },
    message: {},
    mediaAsset: {},
  },
}));

function conversationRow(over: Record<string, unknown> = {}) {
  return [
    {
      conversation: {
        id: "cv_1",
        organizationId: "org_1",
        isTest: false,
        channel: "whatsapp",
        lastInboundAt: new Date(),
        ...over,
      },
      contact: { id: "ct_1", phone: "5215511111111", waIdentity: "ig_123" },
    },
  ];
}

describe("envío de adjuntos — validación antes de disco y red", () => {
  beforeEach(() => {
    graphRequest.mockReset();
    uploadGraphMedia.mockReset();
    saveMediaFile.mockReset();
    getInstagramCredentialsByOrg.mockReset();
    selectRows.length = 0;
    selectCalls.n = 0;
  });

  it("conversación is_test → sandbox_violation sin tocar disco ni Graph", async () => {
    selectRows.push(conversationRow({ id: "cv_test", isTest: true }));
    const { sendMediaMessage } = await import("@/server/inbox/send");

    await expect(
      sendMediaMessage({
        conversationId: "cv_test",
        organizationId: "org_1",
        // Un JPEG VÁLIDO: lo que se prueba es el sandbox, no la firma.
        file: { data: JPEG, mimeType: "image/jpeg" },
      })
    ).rejects.toMatchObject({ code: "sandbox_violation" });

    expect(saveMediaFile).not.toHaveBeenCalled();
    expect(uploadGraphMedia).not.toHaveBeenCalled();
    expect(graphRequest).not.toHaveBeenCalled();
  });

  it("un .exe declarado como PDF → unsupported_type sin siquiera leer la conversación", async () => {
    const { sendMediaMessage } = await import("@/server/inbox/send");
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: {
          data: Buffer.from("MZ\x90\x00programa"),
          mimeType: "application/pdf",
          fileName: "cotizacion.pdf",
        },
      })
    ).rejects.toMatchObject({ code: "unsupported_type" });
    expect(selectCalls.n).toBe(0);
    expect(saveMediaFile).not.toHaveBeenCalled();
  });

  it("WhatsApp: PNG de 6 MB (firma válida) → too_large sin disco ni Graph", async () => {
    selectRows.push(conversationRow());
    const png = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const { sendMediaMessage } = await import("@/server/inbox/send");
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: { data: png, mimeType: "image/png", fileName: "grande.png" },
      })
    ).rejects.toMatchObject({ code: "too_large" });
    expect(saveMediaFile).not.toHaveBeenCalled();
    expect(uploadGraphMedia).not.toHaveBeenCalled();
  });

  it("Instagram: docx → 415 con la frase del canal; vía Zernio, ni un PDF (415)", async () => {
    getInstagramCredentialsByOrg.mockResolvedValue({ status: "connected", source: "meta" });
    const { sendMediaMessage } = await import("@/server/inbox/send");

    selectRows.push(conversationRow({ channel: "instagram" }));
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: { data: makeDocx(), mimeType: "application/msword", fileName: "c.docx" },
      })
    ).rejects.toMatchObject({
      code: "unsupported_type",
      message: "Instagram solo acepta imágenes (JPG/PNG), PDF, audio (AAC/M4A/WAV) y video (MP4/MOV/WEBM)",
    });

    // 018 Bloque 2: Instagram (Meta) ya envía PDF por URL firmada; con
    // Zernio la conexión no admite archivos (outboundFilesFor → null).
    getInstagramCredentialsByOrg.mockResolvedValue({ status: "connected", source: "zernio" });
    selectRows.push(conversationRow({ channel: "instagram" }));
    await expect(
      sendMediaMessage({
        conversationId: "cv_1",
        organizationId: "org_1",
        file: { data: PDF, mimeType: "application/pdf", fileName: "c.pdf" },
      })
    ).rejects.toMatchObject({
      code: "unsupported_type",
      message: "Instagram no permite enviar archivos desde el CRM",
    });
    expect(saveMediaFile).not.toHaveBeenCalled();
    expect(graphRequest).not.toHaveBeenCalled();
  });
});
