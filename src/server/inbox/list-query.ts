import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@/lib/db";
import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from "@/lib/pagination";
import type {
  AssignedFilter,
  InboxFilter,
  InboxOrigin,
  InboxView,
} from "@/lib/types";

/**
 * 06 (contrato 06-0): parámetros de `GET /api/conversations` y del keyset.
 * Fuente de verdad del contrato entre servidor (06-A) y UI (06-B); el detalle
 * está en dev-tasks/06-paginacion-de-la-bandeja.md, "Contrato 06-0".
 *
 * Parseo TOLERANTE (valor inválido → default, sin error), como
 * `src/lib/pagination.ts`. La excepción es `assigned`, que sigue ESTRICTO en
 * la ruta (422 `invalid_query`, lo exige `scripts/e2e-asignacion.mjs`).
 */

export const INBOX_FILTERS: readonly InboxFilter[] = [
  "all",
  "unread",
  "human",
  "mine",
  "unassigned",
  "closing",
];

/** 020: vistas excluyentes de la Bandeja (`?filter=`). */
export const INBOX_VIEWS: readonly InboxView[] = ["all", "unread", "mine", "human"];

/** 020: valores de `?origin=`. */
export const INBOX_ORIGINS: readonly InboxOrigin[] = ["ad", "none"];

/** Tope de ids por `?ids=` (los extra se descartan, sin error). */
export const IDS_MAX = 50;

/** Cursor decodificado: `t` = sort_at con µs, `i` = conversation.id. */
export type InboxCursor = { t: string; i: string };

export type InboxQuery = {
  /** `undefined` = sin `limit` en la URL → lista completa (D-06-1). */
  limit?: number;
  cursor?: InboxCursor;
  /**
   * 020: la VISTA. `filter=unassigned|closing` (pastillas de antes de 020) se
   * traducen al filtro combinable equivalente y la vista queda `all`.
   */
  filter: InboxView;
  stageId?: string;
  channel?: Channel;
  /** 020: filtros combinables del panel (se intersectan entre sí y con la vista). */
  origin?: InboxOrigin;
  unassigned?: boolean;
  closing?: boolean;
  q?: string;
  /** Lote `?ids=` (dedup, máx. IDS_MAX); presente = modo lote. */
  ids?: string[];
  /** `?contact=` (deep link); presente = modo contacto. */
  contactId?: string;
  /** Catch-up legado `?since=` (la UI ya no lo usa; ver RF-06-13). */
  since?: Date;
};

const intParam = z.coerce.number().int().finite();

/**
 * `limit`: ausente o vacío → `undefined` (lista completa, D-06-1). Presente
 * pero ilegible → default 50 (quien lo manda quiere paginar). Fuera de rango
 * → al borde [1, 200].
 */
export function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = intParam.safeParse(raw.trim());
  if (!parsed.success) return PAGE_DEFAULT_LIMIT;
  return Math.min(PAGE_MAX_LIMIT, Math.max(1, parsed.data));
}

const CURSOR_T = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const cursorSchema = z.object({
  t: z.string().regex(CURSOR_T),
  i: z.string().min(1).max(64),
});

/** base64url de `{"t":"YYYY-MM-DD HH24:MI:SS.US","i":"<id>"}`. */
export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.t, i: cursor.i }), "utf8").toString(
    "base64url"
  );
}

/** Cursor ilegible o manipulado → `null` (la ruta responde la 1.ª página). */
export function decodeCursor(raw: string | null | undefined): InboxCursor | null {
  if (!raw) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = cursorSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `a,b,,a` → `["a","b"]`, máx. IDS_MAX. Vacío → `undefined` (no es lote). */
export function parseIds(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 64)
    ),
  ].slice(0, IDS_MAX);
  return ids.length > 0 ? ids : undefined;
}

function optionalText(raw: string | null, max = 200): string | undefined {
  const v = raw?.trim();
  return v && v.length <= max ? v : undefined;
}

export const ASSIGNED_FILTERS: readonly AssignedFilter[] = ["me", "unassigned", "all"];

/**
 * `assigned` ESTRICTO (09, RF-09-12): ausente → `all`; un valor fuera del
 * catálogo → `null` y la ruta responde 422 `invalid_query`. Lo comparten la
 * lista y `/counts` para que fallen igual.
 */
export function parseAssigned(raw: string | null): AssignedFilter | null {
  if (raw === null) return "all";
  return (ASSIGNED_FILTERS as readonly string[]).includes(raw)
    ? (raw as AssignedFilter)
    : null;
}

/** 020: `1`/`true`/`on`/`si` = encendido; cualquier otra cosa, apagado. */
export function parseFlagParam(raw: string | null): boolean {
  return ["1", "true", "on", "si", "sí", "yes"].includes((raw ?? "").trim().toLowerCase());
}

/**
 * 020 — `filter` de la URL → vista + filtros que implica. Tolerante: valor
 * desconocido → `all`. Las pastillas viejas `unassigned` y `closing` (06/05)
 * siguen valiendo: eran excluyentes y hoy son filtros combinables.
 */
export function parseView(raw: string | null): {
  view: InboxView;
  unassigned: boolean;
  closing: boolean;
} {
  const v = (INBOX_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as InboxFilter)
    : "all";
  if (v === "unassigned") return { view: "all", unassigned: true, closing: false };
  if (v === "closing") return { view: "all", unassigned: false, closing: true };
  return { view: v, unassigned: false, closing: false };
}

/** Parseo tolerante de todo menos `assigned` (estricto, en la ruta). */
export function parseInboxQuery(params: URLSearchParams): InboxQuery {
  const channelRaw = params.get("channel");
  const originRaw = params.get("origin");
  const sinceRaw = params.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  const legacy = parseView(params.get("filter"));
  return {
    limit: parseLimit(params.get("limit")),
    cursor: decodeCursor(params.get("cursor")) ?? undefined,
    filter: legacy.view,
    stageId: optionalText(params.get("stage"), 64),
    channel: (CHANNEL_ORDER as readonly string[]).includes(channelRaw ?? "")
      ? (channelRaw as Channel)
      : undefined,
    origin: (INBOX_ORIGINS as readonly string[]).includes(originRaw ?? "")
      ? (originRaw as InboxOrigin)
      : undefined,
    unassigned: legacy.unassigned || parseFlagParam(params.get("unassigned")),
    closing: legacy.closing || parseFlagParam(params.get("closing")),
    q: optionalText(params.get("q")),
    ids: parseIds(params.get("ids")),
    contactId: optionalText(params.get("contact"), 64),
    since: since && !Number.isNaN(since.getTime()) ? since : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * SQL del orden. El texto debe ser IDÉNTICO al del índice
 * `conversation_org_sort_idx` (migración 0016): DESC, sin NULLS LAST.
 * ------------------------------------------------------------------ */

const c = schema.conversation;

/** `coalesce(last_message_at, created_at)` — la clave de orden (sort_at). */
export const sortAtSql: SQL<Date> = sql<Date>`coalesce(${c.lastMessageAt}, ${c.createdAt})`;

/**
 * sort_at como texto con µs, para el cursor. JAMÁS se arma el cursor desde
 * un `Date` de JS (ms): perdería los µs y el keyset saltaría o repetiría filas.
 */
export const sortKeySql: SQL<string> = sql<string>`to_char(${sortAtSql}, 'YYYY-MM-DD HH24:MI:SS.US')`;

/** ORDER BY de la lista: `sort_at DESC, id DESC`. */
export const inboxOrderBy: SQL[] = [sql`${sortAtSql} DESC`, sql`${c.id} DESC`];

/** Keyset: `(sort_at, id) < (cursor.t::timestamp, cursor.i)` (fila-valor). */
export function keysetCondition(cursor: InboxCursor): SQL {
  return sql`(${sortAtSql}, ${c.id}) < (${cursor.t}::timestamp, ${cursor.i})`;
}
