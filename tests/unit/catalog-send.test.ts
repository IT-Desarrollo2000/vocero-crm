import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogFileError, type CatalogFileRow } from "@/server/catalog/files";
import { CatalogBatchError, sendCatalogBatch } from "@/server/catalog/send";
import { SendError } from "@/server/inbox/send";
import { MediaValidationError } from "@/server/media/file-policy";

/**
 * 019 (FR-940/941) — Envío en lote del catálogo: orden, texto primero,
 * skipped/failed por archivo sin abortar, detención del lote y pre-chequeo
 * (ningún id válido → 404 sin enviar nada). Dependencias inyectadas: ni BD,
 * ni disco, ni red.
 */

function row(id: string, over: Partial<CatalogFileRow> = {}): CatalogFileRow {
  return {
    id,
    organizationId: "org_1",
    productId: "pr_1",
    variantId: null,
    kind: "image",
    mimeType: "image/jpeg",
    fileName: `${id}.jpg`,
    fileSize: 10,
    storageProvider: "local",
    storageKey: `org_1/catalog/${id}`,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const rows = new Map<string, CatalogFileRow>();
const calls: string[] = [];

const getCatalogFileRow = vi.fn(async (_org: string, id: string) => rows.get(id) ?? null);
const readCatalogFileData = vi.fn(async (r: CatalogFileRow) => Buffer.from(r.id));
const sendText = vi.fn(async (input: { text: string }) => {
  calls.push(`text:${input.text}`);
  return { messageId: "msg_text" };
});
const sendMediaMessage = vi.fn(
  async (input: { file: { fileName?: string }; productFileId?: string }) => {
    calls.push(`file:${input.productFileId}`);
    return { messageId: `msg_${input.productFileId}` };
  }
);

const deps = () => ({
  getCatalogFileRow,
  readCatalogFileData,
  sendText: sendText as never,
  sendMediaMessage: sendMediaMessage as never,
});

const batch = (fileIds: string[], text?: string) =>
  sendCatalogBatch({ conversationId: "cv_1", organizationId: "org_1", text, fileIds }, deps());

describe("sendCatalogBatch", () => {
  beforeEach(() => {
    rows.clear();
    for (const id of ["pf_a", "pf_b", "pf_c"]) rows.set(id, row(id));
    calls.length = 0;
    getCatalogFileRow.mockClear();
    readCatalogFileData.mockClear();
    sendText.mockClear();
    sendMediaMessage.mockClear();
  });

  it("texto primero y luego los archivos en el orden recibido", async () => {
    const r = await batch(["pf_c", "pf_a", "pf_b"], "Hola");
    expect(calls).toEqual(["text:Hola", "file:pf_c", "file:pf_a", "file:pf_b"]);
    expect(r).toEqual({
      text: { messageId: "msg_text" },
      results: [
        { fileId: "pf_c", status: "sent", messageId: "msg_pf_c" },
        { fileId: "pf_a", status: "sent", messageId: "msg_pf_a" },
        { fileId: "pf_b", status: "sent", messageId: "msg_pf_b" },
      ],
    });
    expect(r.stopped).toBeUndefined();
  });

  it("sin texto no llama a sendText", async () => {
    const r = await batch(["pf_a"]);
    expect(sendText).not.toHaveBeenCalled();
    expect(r.text).toBeUndefined();
    expect(r.results).toEqual([{ fileId: "pf_a", status: "sent", messageId: "msg_pf_a" }]);
  });

  it("pasa bytes, MIME y nombre de la fila, y productFileId como procedencia", async () => {
    rows.set("pf_d", row("pf_d", { mimeType: "application/pdf", fileName: "ficha.pdf" }));
    await batch(["pf_d"]);
    expect(sendMediaMessage).toHaveBeenCalledWith({
      conversationId: "cv_1",
      organizationId: "org_1",
      file: { data: Buffer.from("pf_d"), mimeType: "application/pdf", fileName: "ficha.pdf" },
      productFileId: "pf_d",
    });
  });

  it("ids repetidos se envían una vez, conservando la primera aparición", async () => {
    const r = await batch(["pf_b", "pf_a", "pf_b", "pf_a"]);
    expect(calls).toEqual(["file:pf_b", "file:pf_a"]);
    expect(r.results.map((i) => i.fileId)).toEqual(["pf_b", "pf_a"]);
  });

  it("MediaValidationError → skipped con la razón de la política y sigue", async () => {
    sendMediaMessage.mockImplementationOnce(async () => {
      throw new MediaValidationError("too_large", "Supera el límite de imágenes (5 MB)");
    });
    const r = await batch(["pf_a", "pf_b"]);
    expect(r.results).toEqual([
      { fileId: "pf_a", status: "skipped", reason: "Supera el límite de imágenes (5 MB)" },
      { fileId: "pf_b", status: "sent", messageId: "msg_pf_b" },
    ]);
    expect(r.stopped).toBeUndefined();
  });

  it("meta_error / upload_failed → failed (con messageId si se persistió) y sigue", async () => {
    sendMediaMessage
      .mockImplementationOnce(async () => {
        throw new SendError("meta_error", "rechazado");
      })
      .mockImplementationOnce(async () => {
        const e = new SendError("upload_failed", "no subió");
        e.messageId = "msg_failed";
        throw e;
      });
    const r = await batch(["pf_a", "pf_b", "pf_c"]);
    expect(r.results).toEqual([
      { fileId: "pf_a", status: "failed", reason: "meta_error" },
      { fileId: "pf_b", status: "failed", reason: "upload_failed", messageId: "msg_failed" },
      { fileId: "pf_c", status: "sent", messageId: "msg_pf_c" },
    ]);
  });

  it("id inexistente → failed not_found; errores de almacenamiento → failed con su código", async () => {
    readCatalogFileData
      .mockImplementationOnce(async () => {
        throw new CatalogFileError("file_missing", "no está");
      })
      .mockImplementationOnce(async () => {
        throw new CatalogFileError("storage_unavailable", "caído");
      });
    const r = await batch(["pf_x", "pf_a", "pf_b", "pf_c"]);
    expect(r.results).toEqual([
      { fileId: "pf_x", status: "failed", reason: "not_found" },
      { fileId: "pf_a", status: "failed", reason: "file_missing" },
      { fileId: "pf_b", status: "failed", reason: "storage_unavailable" },
      { fileId: "pf_c", status: "sent", messageId: "msg_pf_c" },
    ]);
  });

  it("window_closed a mitad del lote → stopped; los no intentados quedan failed `stopped`", async () => {
    sendMediaMessage
      .mockImplementationOnce(async () => ({ messageId: "msg_pf_a" }))
      .mockImplementationOnce(async () => {
        throw new SendError("window_closed", "ventana cerrada");
      });
    const r = await batch(["pf_a", "pf_b", "pf_c"]);
    expect(sendMediaMessage).toHaveBeenCalledTimes(2);
    expect(r.stopped).toBe("window_closed");
    expect(r.results).toEqual([
      { fileId: "pf_a", status: "sent", messageId: "msg_pf_a" },
      { fileId: "pf_b", status: "failed", reason: "window_closed" },
      { fileId: "pf_c", status: "failed", reason: "stopped" },
    ]);
  });

  it("tras el texto, un corte en el primer archivo también es stopped (el texto ya salió)", async () => {
    sendMediaMessage.mockImplementationOnce(async () => {
      throw new SendError("meta_unavailable", "Meta caída");
    });
    const r = await batch(["pf_a", "pf_b"], "Hola");
    expect(r.text).toEqual({ messageId: "msg_text" });
    expect(r.stopped).toBe("meta_unavailable");
    expect(r.results).toEqual([
      { fileId: "pf_a", status: "failed", reason: "meta_unavailable" },
      { fileId: "pf_b", status: "failed", reason: "stopped" },
    ]);
  });

  it("window_closed en el primer envío (sin texto) → se propaga", async () => {
    sendMediaMessage.mockImplementationOnce(async () => {
      throw new SendError("window_closed", "ventana cerrada");
    });
    await expect(batch(["pf_a", "pf_b"])).rejects.toMatchObject({ code: "window_closed" });
    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("si nada salió aún (not_found y skipped previos), el corte también se propaga", async () => {
    sendMediaMessage
      .mockImplementationOnce(async () => {
        throw new MediaValidationError("unsupported_type", "Tipo no admitido");
      })
      .mockImplementationOnce(async () => {
        throw new SendError("not_connected", "sin número");
      });
    await expect(batch(["pf_x", "pf_a", "pf_b", "pf_c"])).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(sendMediaMessage).toHaveBeenCalledTimes(2);
  });

  it("sandbox_violation en el texto se propaga y no se intenta ningún archivo", async () => {
    sendText.mockImplementationOnce(async () => {
      throw new SendError("sandbox_violation", "Laboratorio");
    });
    await expect(batch(["pf_a", "pf_b"], "Hola")).rejects.toBeInstanceOf(SendError);
    expect(sendMediaMessage).not.toHaveBeenCalled();
    expect(readCatalogFileData).not.toHaveBeenCalled();
  });

  it("sandbox_violation sin texto se propaga en el primer archivo y no sigue", async () => {
    sendMediaMessage.mockImplementationOnce(async () => {
      throw new SendError("sandbox_violation", "Laboratorio");
    });
    await expect(batch(["pf_a", "pf_b"])).rejects.toMatchObject({ code: "sandbox_violation" });
    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("ningún id existe en la org → CatalogBatchError not_found sin enviar el texto", async () => {
    await expect(batch(["pf_x", "pf_y"], "Hola")).rejects.toBeInstanceOf(CatalogBatchError);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMediaMessage).not.toHaveBeenCalled();
    expect(getCatalogFileRow).toHaveBeenCalledWith("org_1", "pf_x");
  });
});
