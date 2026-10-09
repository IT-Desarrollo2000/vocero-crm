import { z } from "zod";

/**
 * Paginación por `limit`/`offset` de los listados de la API.
 *
 * Offset y no cursor: el directorio se ordena por `updatedAt`, que cambia en
 * cuanto entra un mensaje; un cursor sobre esa columna se saltaría al contacto
 * que se movió mientras se paginaba. El cliente deduplica por `id` lo que un
 * offset repita en ese caso.
 *
 * Tolerante como `clamp` de `/api/bot/availability`: un valor fuera de rango
 * se ajusta al borde y uno ilegible cae al default, en vez de responder 422 a
 * una URL tecleada a mano.
 */
export const PAGE_DEFAULT_LIMIT = 50;
export const PAGE_MAX_LIMIT = 200;

const intParam = z.coerce.number().int().finite();

function toInt(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = intParam.safeParse(raw.trim());
  return parsed.success ? parsed.data : null;
}

export type Page = { limit: number; offset: number };

export function parsePage(params: URLSearchParams): Page {
  const limit = toInt(params.get("limit"));
  const offset = toInt(params.get("offset"));
  return {
    limit:
      limit === null
        ? PAGE_DEFAULT_LIMIT
        : Math.min(PAGE_MAX_LIMIT, Math.max(1, limit)),
    offset: offset === null ? 0 : Math.max(0, offset),
  };
}

/** Offset de la siguiente página, o `null` si ya no queda nada. */
export function nextOffset(page: Page, received: number, total: number): number | null {
  const next = page.offset + received;
  return received > 0 && next < total ? next : null;
}
