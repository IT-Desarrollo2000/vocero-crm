/**
 * 019 — Archivos del catálogo "escenificados" en el compositor (FR-930..933):
 * los chips que deja un atajo ligado a producto o el botón Catálogo, antes de
 * enviarlos con `POST /api/conversations/:id/messages/catalog`.
 *
 * Lógica pura, sin React: la cubre `tests/unit/catalog-staging.test.ts`. La
 * compatibilidad con el canal NO se guarda en el estado: se calcula al pintar
 * y al enviar con `fileCompatibility` (una sola fuente de verdad).
 */

import {
  CATALOG_LIMITS,
  fileCompatibility,
  filesForAttach,
  filesForVariant,
  type CatalogBatchResult,
  type CatalogFileDto,
  type CatalogProductDto,
} from "@/lib/catalog";
import type { OutboundFiles } from "@/lib/outbound-files";
import type { QuickReplyDto } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Respuestas rápidas visibles en el compositor
 * ------------------------------------------------------------------ */

/**
 * Respuestas que ofrece el compositor (selector `/` y chips). Se ocultan las
 * ligadas a un producto INACTIVO (FR-907) y las que no aportan nada: sin
 * texto y sin archivos (p. ej. el producto se borró y quedó con body vacío).
 */
export function visibleQuickReplies<
  T extends Pick<QuickReplyDto, "body" | "product">,
>(list: readonly T[]): T[] {
  return list.filter((r) => {
    if (r.product && !r.product.active) return false;
    const files = r.product?.files.length ?? 0;
    return r.body.trim().length > 0 || files > 0;
  });
}

/** Archivos que escenifica una respuesta al elegirla (ya filtrados por `attach`). */
export function quickReplyFiles(reply: Pick<QuickReplyDto, "product">): CatalogFileDto[] {
  if (!reply.product || !reply.product.active) return [];
  return reply.product.files;
}

/* ------------------------------------------------------------------ *
 * Escenificar
 * ------------------------------------------------------------------ */

export type StageResult = {
  staged: CatalogFileDto[];
  /** Cuántos se agregaron de verdad. */
  added: number;
  /** Compatibles que no cupieron por el tope (no se agregan). */
  overLimit: number;
};

/**
 * Agrega `incoming` al final de `current` sin duplicar por id. El tope
 * (`max`, por defecto `CATALOG_LIMITS.maxBatchFiles`) cuenta SOLO los
 * compatibles con el canal: los incompatibles se muestran en gris pero no
 * viajan. Al llegar al tope, el resto de compatibles se descarta.
 */
export function stageFiles(
  current: readonly CatalogFileDto[],
  incoming: readonly CatalogFileDto[],
  outboundFiles: OutboundFiles | null,
  max: number = CATALOG_LIMITS.maxBatchFiles
): StageResult {
  const staged = [...current];
  const ids = new Set(staged.map((f) => f.id));
  let sendable = staged.filter((f) => fileCompatibility(f, outboundFiles).ok).length;
  let added = 0;
  let overLimit = 0;
  for (const file of incoming) {
    if (ids.has(file.id)) continue;
    const ok = fileCompatibility(file, outboundFiles).ok;
    if (ok && sendable >= max) {
      overLimit++;
      continue;
    }
    staged.push(file);
    ids.add(file.id);
    added++;
    if (ok) sendable++;
  }
  return { staged, added, overLimit };
}

export type SplitStaged = {
  sendable: CatalogFileDto[];
  blocked: Array<{ file: CatalogFileDto; reason: string }>;
};

/** Separa los escenificados en enviables y bloqueados (con su razón). */
export function splitStaged(
  staged: readonly CatalogFileDto[],
  outboundFiles: OutboundFiles | null
): SplitStaged {
  const out: SplitStaged = { sendable: [], blocked: [] };
  for (const file of staged) {
    const c = fileCompatibility(file, outboundFiles);
    if (c.ok) out.sendable.push(file);
    else out.blocked.push({ file, reason: c.reason });
  }
  return out;
}

/**
 * Body del POST de catálogo: texto (si no está vacío) + ids enviables EN
 * ORDEN. null = no hay ningún archivo enviable (no se manda el lote).
 */
export function catalogBatchBody(
  text: string,
  staged: readonly CatalogFileDto[],
  outboundFiles: OutboundFiles | null
): { text?: string; fileIds: string[] } | null {
  const fileIds = splitStaged(staged, outboundFiles)
    .sendable.slice(0, CATALOG_LIMITS.maxBatchFiles)
    .map((f) => f.id);
  if (fileIds.length === 0) return null;
  const value = text.trim();
  return value ? { text: value, fileIds } : { fileIds };
}

/**
 * Qué chips quedan tras un envío: se conservan SOLO los `failed` (para
 * reintentar). Los enviados, los `skipped` (el canal los rechazó) y los
 * incompatibles se retiran.
 */
export function stagedAfterSend(
  staged: readonly CatalogFileDto[],
  result: Pick<CatalogBatchResult, "results">
): CatalogFileDto[] {
  const failed = new Set(
    result.results.filter((r) => r.status === "failed").map((r) => r.fileId)
  );
  return staged.filter((f) => failed.has(f.id));
}

/* ------------------------------------------------------------------ *
 * Resumen del envío (FR-941)
 * ------------------------------------------------------------------ */

const FAILED_REASONS: Record<string, string> = {
  not_found: "ya no existe en el catálogo",
  file_missing: "el archivo no está en el almacenamiento",
  storage_unavailable: "el almacenamiento no respondió",
  meta_error: "la plataforma lo rechazó",
  upload_failed: "no se pudo subir",
  stopped: "no se intentó",
};

const STOP_REASONS: Record<string, string> = {
  window_closed: "la ventana de conversación está cerrada",
  not_connected: "el canal no está conectado",
  reconnect_required: "hay que reconectar el canal",
  sandbox_violation: "las conversaciones de prueba no envían a la plataforma",
  meta_unavailable: "la plataforma no responde",
  unsupported_channel: "este canal no admite el envío",
};

/** Razón legible de un `failed` (los `skipped` ya traen la razón legible). */
export function failedReasonText(reason: string | undefined): string {
  if (!reason) return "falló";
  return FAILED_REASONS[reason] ?? STOP_REASONS[reason] ?? reason;
}

/** Razón legible del código que detuvo el lote. */
export function stopReasonText(code: string): string {
  return STOP_REASONS[code] ?? code;
}

/**
 * Resumen breve del envío: "3 de 4 enviados · 1 no es compatible con este
 * canal · ficha.xlsx: <razón>". `total` cuenta los intentados y los
 * incompatibles que se quedaron en el cliente.
 */
export function summarizeBatch(
  result: CatalogBatchResult,
  staged: readonly CatalogFileDto[],
  blockedCount: number
): string {
  const names = new Map(staged.map((f) => [f.id, f.fileName]));
  const name = (id: string) => names.get(id) ?? "Archivo";
  const sent = result.results.filter((r) => r.status === "sent").length;
  const total = result.results.length + blockedCount;
  const parts = [`${sent} de ${total} ${total === 1 ? "enviado" : "enviados"}`];
  if (blockedCount > 0) {
    parts.push(
      blockedCount === 1
        ? "1 no es compatible con este canal"
        : `${blockedCount} no son compatibles con este canal`
    );
  }
  for (const r of result.results) {
    if (r.status === "skipped") parts.push(`${name(r.fileId)}: ${r.reason ?? "omitido"}`);
    // Los que cortó el lote (o el que lo cortó) se resumen en "Se detuvo".
    const byStop = r.reason === "stopped" || (!!result.stopped && r.reason === result.stopped);
    if (r.status === "failed" && !byStop) {
      parts.push(`${name(r.fileId)}: ${failedReasonText(r.reason)}`);
    }
  }
  if (result.stopped) parts.push(`Se detuvo: ${stopReasonText(result.stopped)}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * Panel Catálogo (FR-931)
 * ------------------------------------------------------------------ */

/**
 * Archivos que ofrece el panel para un producto: con variante, los
 * compartidos + los de esa variante; con "Todas" (null), los compartidos + los
 * de todas las variantes ACTIVAS.
 */
export function panelFiles(
  product: Pick<CatalogProductDto, "files" | "variants">,
  variantId: string | null
): CatalogFileDto[] {
  return variantId === null
    ? filesForAttach(product, "all")
    : filesForVariant(product, variantId);
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Productos ACTIVOS que muestra el panel, filtrados por categoría (null =
 * todas) y por búsqueda en nombre o código (sin mayúsculas ni acentos).
 */
export function filterCatalogProducts<
  T extends Pick<CatalogProductDto, "name" | "code" | "active" | "categoryId">,
>(products: readonly T[], query: string, categoryId: string | null): T[] {
  const q = fold(query.trim());
  return products.filter(
    (p) =>
      p.active &&
      (categoryId === null || p.categoryId === categoryId) &&
      (!q || fold(p.name).includes(q) || fold(p.code ?? "").includes(q))
  );
}

/** Portada del producto: su primera imagen (compartida primero). */
export function productCover(
  product: Pick<CatalogProductDto, "files" | "variants">
): CatalogFileDto | null {
  return filesForAttach(product, "images")[0] ?? null;
}
