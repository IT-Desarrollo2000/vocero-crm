import type { CatalogBatchResult } from "@/lib/catalog";
import { SendError, sendMediaMessage, sendText } from "@/server/inbox/send";
import { MediaValidationError } from "@/server/media/file-policy";
import {
  CatalogFileError,
  type CatalogFileRow,
  getCatalogFileRow,
  readCatalogFileData,
} from "./files";

/**
 * 019 — Envío en lote del catálogo (`POST …/messages/catalog`, FR-940/941).
 *
 * Orden: pre-chequeo de TODAS las filas (si ninguna existe en la org →
 * `CatalogBatchError("not_found")`, sin enviar ni el texto) → texto, si hay
 * (un SendError del texto se propaga: no sale nada más) → cada archivo en el
 * orden recibido, sin repetidos (gana la primera aparición).
 *
 * Por archivo:
 *   - no existe en la org            → failed `not_found`
 *   - CatalogFileError               → failed `file_missing` | `storage_unavailable`
 *   - MediaValidationError (413/415) → skipped, razón legible de la política
 *   - SendError meta_error/upload_failed → failed con el código y sigue
 *   - SendError que DETIENE (`STOP_CODES`):
 *       · si aún no salió nada (ni texto ni archivo `sent`) → se propaga y la
 *         ruta responde el status habitual (igual que un envío suelto);
 *       · si ya salió algo → ese archivo failed con el código, `stopped` =
 *         código y los restantes NO se intentan: aparecen como failed
 *         `stopped`, de modo que `results` siempre trae un item por id.
 *
 * Un failed que alcanzó a persistirse como mensaje `failed` (SendError con
 * `messageId`) lleva ese `messageId` para que la UI lo ubique en el hilo.
 */

/** Códigos de SendError que detienen el lote (FR-941). */
const STOP_CODES: ReadonlySet<SendError["code"]> = new Set([
  "window_closed",
  "not_connected",
  "reconnect_required",
  "sandbox_violation",
  "meta_unavailable",
  "unsupported_channel",
]);

/** Razón de los archivos que no se intentaron tras detener el lote. */
export const STOPPED_REASON = "stopped";

/** Ningún `fileId` existe en la organización → la ruta responde 404. */
export class CatalogBatchError extends Error {
  code: "not_found";
  constructor(code: CatalogBatchError["code"], message: string) {
    super(message);
    this.name = "CatalogBatchError";
    this.code = code;
  }
}

export type CatalogBatchDeps = {
  sendText?: typeof sendText;
  sendMediaMessage?: typeof sendMediaMessage;
  getCatalogFileRow?: typeof getCatalogFileRow;
  readCatalogFileData?: typeof readCatalogFileData;
};

type ResultItem = CatalogBatchResult["results"][number];

export async function sendCatalogBatch(
  input: {
    conversationId: string;
    organizationId: string;
    text?: string;
    fileIds: string[];
  },
  deps: CatalogBatchDeps = {}
): Promise<CatalogBatchResult> {
  const doSendText = deps.sendText ?? sendText;
  const doSendMedia = deps.sendMediaMessage ?? sendMediaMessage;
  const getRow = deps.getCatalogFileRow ?? getCatalogFileRow;
  const readData = deps.readCatalogFileData ?? readCatalogFileData;

  const fileIds = [...new Set(input.fileIds)];

  // Pre-chequeo: nada sale si ningún archivo existe (ni un texto huérfano).
  const rows = new Map<string, CatalogFileRow | null>();
  for (const fileId of fileIds) {
    rows.set(fileId, await getRow(input.organizationId, fileId));
  }
  if (![...rows.values()].some((r) => r !== null)) {
    throw new CatalogBatchError("not_found", "Ningún archivo del catálogo existe");
  }

  const result: CatalogBatchResult = { results: [] };
  let anySent = false;

  const text = input.text?.trim();
  if (text) {
    // Un SendError aquí se propaga: no sale nada más del lote.
    const sent = await doSendText({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      text,
    });
    result.text = { messageId: sent.messageId };
    anySent = true;
  }

  for (const [index, fileId] of fileIds.entries()) {
    const row = rows.get(fileId) ?? null;
    if (!row) {
      result.results.push({ fileId, status: "failed", reason: "not_found" });
      continue;
    }

    let item: ResultItem;
    try {
      const data = await readData(row);
      const sent = await doSendMedia({
        conversationId: input.conversationId,
        organizationId: input.organizationId,
        file: { data, mimeType: row.mimeType, fileName: row.fileName },
        productFileId: row.id,
      });
      item = { fileId, status: "sent", messageId: sent.messageId };
      anySent = true;
    } catch (err) {
      if (err instanceof CatalogFileError) {
        item = { fileId, status: "failed", reason: err.code };
      } else if (err instanceof MediaValidationError) {
        item = { fileId, status: "skipped", reason: err.message };
      } else if (err instanceof SendError) {
        if (STOP_CODES.has(err.code)) {
          // Primer envío del lote: mismo status que un envío suelto.
          if (!anySent) throw err;
          result.results.push(failedItem(fileId, err.code, err.messageId));
          for (const rest of fileIds.slice(index + 1)) {
            result.results.push({ fileId: rest, status: "failed", reason: STOPPED_REASON });
          }
          result.stopped = err.code;
          return result;
        }
        item = failedItem(fileId, err.code, err.messageId);
      } else {
        throw err;
      }
    }
    result.results.push(item);
  }

  return result;
}

function failedItem(fileId: string, reason: string, messageId?: string): ResultItem {
  return messageId
    ? { fileId, status: "failed", reason, messageId }
    : { fileId, status: "failed", reason };
}
