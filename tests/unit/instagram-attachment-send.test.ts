import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import { sendInstagramAttachment } from "@/server/instagram/send";
import type { InstagramCredentials } from "@/server/instagram/credentials";

/**
 * 018 (FR-811, arreglo IG) — Instagram ya no recibe una URL para descargar:
 * su descargador no baja nada de nuestro dominio (code 100 / 2018007). El
 * archivo se SUBE (`message_attachments` multipart) y se envía por
 * `attachment_id`: imagen en `attachments` (arreglo), lo demás en
 * `attachment` (singular), con reintento único en singular si Meta rechaza
 * el arreglo como parámetro inválido.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF");

const credentials = {
  organizationId: "org_1",
  status: "connected",
  source: "meta",
  token: "ig-token",
  igUserId: "igu_1",
} as unknown as InstagramCredentials;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const uploadOk = (id = "att_1") => Response.json({ attachment_id: id });
const sentOk = (id = "igm.1") => Response.json({ recipient_id: "igsid_1", message_id: id });
const graphError = (status: number, code: number, message = "(#100) Invalid parameter") =>
  Response.json({ error: { message, type: "OAuthException", code } }, { status });

function call(i: number) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init };
}
type SentBody = {
  recipient?: { id?: string };
  message: { attachments?: unknown[]; attachment?: unknown };
  messaging_type?: string;
  tag?: string;
};
function jsonBody(i: number) {
  return JSON.parse(String(call(i).init.body)) as SentBody;
}

const image = { kind: "image" as const, data: PNG, mimeType: "image/png", fileName: "foto.png" };
const pdf = {
  kind: "document" as const,
  data: PDF,
  mimeType: "application/pdf",
  fileName: "cotizacion.pdf",
};

describe("sendInstagramAttachment — subida multipart", () => {
  it("POST {igUserId}/message_attachments con platform, message y filedata (sin Content-Type a mano)", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(sentOk());
    await sendInstagramAttachment({ credentials, recipient: "igsid_1", file: image });

    const { url, init } = call(0);
    expect(url).toMatch(/\/v\d+\.\d+\/igu_1\/message_attachments$/);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ig-token");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("platform")).toBe("instagram");
    expect(JSON.parse(String(form.get("message")))).toEqual({
      attachment: { type: "image", payload: { is_reusable: false } },
    });
    const file = form.get("filedata") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(PNG.length);
    expect(file.name).toBe("foto.png");
    // La etiqueta y el destinatario NO van en la subida.
    expect(form.get("tag")).toBeNull();
    expect(form.get("recipient")).toBeNull();
  });

  it("PDF se sube como type file", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(sentOk());
    await sendInstagramAttachment({ credentials, recipient: "igsid_1", file: pdf });
    const form = call(0).init.body as FormData;
    expect(JSON.parse(String(form.get("message"))).attachment.type).toBe("file");
    expect((form.get("filedata") as File).type).toBe("application/pdf");
  });

  it("sin attachment_id en la respuesta → MetaApiError claro y no llama a /messages", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await expect(
      sendInstagramAttachment({ credentials, recipient: "igsid_1", file: image })
    ).rejects.toThrow(/attachment_id/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token muerto en la subida → MetaApiError con isAuthError", async () => {
    fetchMock.mockResolvedValueOnce(graphError(401, 190, "Invalid OAuth access token"));
    const err = await sendInstagramAttachment({
      credentials,
      recipient: "igsid_1",
      file: image,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).isAuthError).toBe(true);
  });

  it("Zernio no envía archivos (ni toca la red)", async () => {
    await expect(
      sendInstagramAttachment({
        credentials: { ...credentials, source: "zernio" } as InstagramCredentials,
        recipient: "igsid_1",
        file: image,
      })
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendInstagramAttachment — envío por attachment_id", () => {
  it("imagen → message.attachments (arreglo) con el id subido", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk("att_img")).mockResolvedValueOnce(sentOk("igm.9"));
    const res = await sendInstagramAttachment({ credentials, recipient: "igsid_1", file: image });

    expect(res).toEqual({ platformMessageId: "igm.9" });
    expect(call(1).url).toMatch(/\/igu_1\/messages$/);
    const body = jsonBody(1);
    expect(body.recipient).toEqual({ id: "igsid_1" });
    expect(body.message).toEqual({
      attachments: [{ type: "image", payload: { attachment_id: "att_img" } }],
    });
    expect(body.tag).toBeUndefined();
    expect(body.messaging_type).toBeUndefined();
  });

  it("PDF → message.attachment singular con type file", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk("att_pdf")).mockResolvedValueOnce(sentOk());
    await sendInstagramAttachment({ credentials, recipient: "igsid_1", file: pdf });
    expect(jsonBody(1).message).toEqual({
      attachment: { type: "file", payload: { attachment_id: "att_pdf" } },
    });
  });

  it("audio y video → attachment singular con su type", async () => {
    for (const kind of ["audio", "video"] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(uploadOk(`att_${kind}`)).mockResolvedValueOnce(sentOk());
      await sendInstagramAttachment({
        credentials,
        recipient: "igsid_1",
        file: { kind, data: PNG, mimeType: kind === "audio" ? "audio/mp4" : "video/mp4", fileName: null },
      });
      expect(jsonBody(1).message).toEqual({
        attachment: { type: kind, payload: { attachment_id: `att_${kind}` } },
      });
      // Sin nombre, el multipart lleva uno genérico.
      expect(((call(0).init.body as FormData).get("filedata") as File).name).toBe("adjunto");
    }
  });

  it("HUMAN_AGENT va SOLO en /messages", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(sentOk());
    await sendInstagramAttachment({
      credentials,
      recipient: "igsid_1",
      file: image,
      humanAgentTag: true,
    });
    const form = call(0).init.body as FormData;
    expect(form.get("tag")).toBeNull();
    expect(form.get("messaging_type")).toBeNull();
    expect(jsonBody(1)).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("imagen rechazada en arreglo (400/100) → reintenta UNA vez en singular", async () => {
    fetchMock
      .mockResolvedValueOnce(uploadOk("att_r"))
      .mockResolvedValueOnce(graphError(400, 100))
      .mockResolvedValueOnce(sentOk("igm.r"));
    const res = await sendInstagramAttachment({
      credentials,
      recipient: "igsid_1",
      file: image,
      humanAgentTag: true,
    });
    expect(res.platformMessageId).toBe("igm.r");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jsonBody(1).message.attachments).toBeDefined();
    expect(jsonBody(2).message).toEqual({
      attachment: { type: "image", payload: { attachment_id: "att_r" } },
    });
    // El reintento conserva la etiqueta.
    expect(jsonBody(2).tag).toBe("HUMAN_AGENT");
  });

  it("si el singular también falla, el error sale (no hay un segundo reintento)", async () => {
    fetchMock
      .mockResolvedValueOnce(uploadOk())
      .mockResolvedValueOnce(graphError(400, 100))
      .mockResolvedValueOnce(graphError(400, 100, "otra vez"));
    await expect(
      sendInstagramAttachment({ credentials, recipient: "igsid_1", file: image })
    ).rejects.toThrow("otra vez");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("errores que no son 400/100 (auth 190, permiso 10, 5xx) NO reintentan", async () => {
    for (const [status, code] of [
      [401, 190],
      [400, 190],
      [403, 10],
      [500, 2],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(graphError(status, code));
      const err = await sendInstagramAttachment({
        credentials,
        recipient: "igsid_1",
        file: image,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetaApiError);
      expect((err as MetaApiError).status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("PDF rechazado con 400/100 no reintenta (el reintento es solo de la imagen)", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(graphError(400, 100));
    await expect(
      sendInstagramAttachment({ credentials, recipient: "igsid_1", file: pdf })
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("/messages sin message_id → MetaApiError", async () => {
    fetchMock.mockResolvedValueOnce(uploadOk()).mockResolvedValueOnce(Response.json({}));
    await expect(
      sendInstagramAttachment({ credentials, recipient: "igsid_1", file: pdf })
    ).rejects.toThrow(/ID del mensaje/);
  });
});
