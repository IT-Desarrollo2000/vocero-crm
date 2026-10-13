/**
 * Alertas del navegador (dev-tasks/05): lógica PURA, sin DOM ni React, para
 * que se pruebe en el entorno `node` de Vitest. Las piezas con navegador
 * (`Notification`, `BroadcastChannel`, Web Locks, canvas, audio) viven en
 * `src/components/` y solo llaman a esto.
 *
 * Constitución II: solo Notification API del navegador. Nada de email, push
 * de terceros ni servicios externos.
 */

import { handoffLabel } from "@/lib/handoff-labels";
import { previewText } from "@/components/inbox/helpers";

// ── Preferencias (RF-05-10) ─────────────────────────────────────────────────

export type AlertPrefs = {
  /** Interruptor maestro de las notificaciones del sistema. */
  notifications: boolean;
  /** Avisar de mensajes entrantes. */
  incoming: boolean;
  /** Avisar cuando una conversación pasa a necesitar humano. */
  handoffs: boolean;
  /** Sonido corto (Web Audio), máximo uno cada 3 s. */
  sound: boolean;
  /** Vista previa del texto en la notificación (D-05-6: encendido). */
  showContent: boolean;
  /** `(N)` en el título y punto en el favicon. */
  tabCounter: boolean;
};

/**
 * Por defecto (y ante datos corruptos): todo apagado salvo el contador de la
 * pestaña. `incoming`/`handoffs` quedan encendidos para que, al activar las
 * notificaciones, avisen de ambos sin un segundo paso.
 */
export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  notifications: false,
  incoming: true,
  handoffs: true,
  sound: false,
  showContent: true,
  tabCounter: true,
};

const PREFS_PREFIX = "vocero.alerts.v1";

/** Clave por usuario Y dispositivo: varios usuarios en el mismo navegador. */
export function alertPrefsKey(userId: string): string {
  return `${PREFS_PREFIX}.${userId}`;
}

/** Lo mínimo de `Storage` que se usa (inyectable en pruebas). */
export type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

/** Normaliza lo leído: cada campo que no sea booleano cae a su default. */
export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (!raw) return { ...DEFAULT_ALERT_PREFS };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_ALERT_PREFS };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ...DEFAULT_ALERT_PREFS };
  }
  const obj = data as Record<string, unknown>;
  const out = { ...DEFAULT_ALERT_PREFS };
  for (const k of Object.keys(DEFAULT_ALERT_PREFS) as (keyof AlertPrefs)[]) {
    const v = obj[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function loadAlertPrefs(
  userId: string,
  storage: PrefsStorage | null
): AlertPrefs {
  if (!storage) return { ...DEFAULT_ALERT_PREFS };
  try {
    return parseAlertPrefs(storage.getItem(alertPrefsKey(userId)));
  } catch {
    // Acceso bloqueado (modo privado estricto, cuota): defaults.
    return { ...DEFAULT_ALERT_PREFS };
  }
}

/** Devuelve `false` si no se pudo guardar (la UI sigue con el valor en memoria). */
export function saveAlertPrefs(
  userId: string,
  prefs: AlertPrefs,
  storage: PrefsStorage | null
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(alertPrefsKey(userId), JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

// ── Eventos y decisión (RF-05-02..04, RF-05-12) ─────────────────────────────

/** Lo que interesa de un `message.new` (el DTO completo es `MessageDto`). */
export type IncomingMessageEvent = {
  kind: "message";
  conversationId: string;
  messageId: string;
  direction: "in" | "out";
  type: string;
  text: string | null;
};

/** `conversation.handoff` del contrato 05/02-0. */
export type HandoffAlertEvent = {
  kind: "handoff";
  conversationId: string;
  reason: string;
  handoffAt: string;
};

export type AlertEvent = IncomingMessageEvent | HandoffAlertEvent;

/** Permiso de notificaciones, o que el navegador no las soporta. */
export type AlertPermission = NotificationPermission | "unsupported";

export type AlertContext = {
  permission: AlertPermission;
  /**
   * ¿Alguna pestaña VISIBLE tiene abierta esta conversación en la Bandeja?
   * (RF-05-04; lo calcula `isConversationInView` con la presencia de todas.)
   */
  conversationInView: boolean;
};

/**
 * Convierte el payload crudo de `message.new` en evento de alerta, o `null`
 * si no trae lo necesario (payload inesperado: no se alerta, no se rompe).
 */
export function messageAlertEvent(data: {
  conversationId?: unknown;
  message?: unknown;
}): IncomingMessageEvent | null {
  const m = data.message as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : typeof m.conversationId === "string"
        ? m.conversationId
        : null;
  if (!conversationId || typeof m.id !== "string") return null;
  if (m.direction !== "in" && m.direction !== "out") return null;
  return {
    kind: "message",
    conversationId,
    messageId: m.id,
    direction: m.direction,
    type: typeof m.type === "string" ? m.type : "text",
    text: typeof m.text === "string" ? m.text : null,
  };
}

/**
 * ¿El evento amerita aviso (notificación o sonido), sin mirar el permiso?
 * Saliente → no; `manual_reply` → no (ya hay un humano); tipo apagado → no;
 * conversación a la vista → no.
 */
export function isAlertWorthy(
  event: AlertEvent,
  prefs: AlertPrefs,
  ctx: Pick<AlertContext, "conversationInView">
): boolean {
  if (event.kind === "message") {
    if (event.direction !== "in") return false;
    if (!prefs.incoming) return false;
  } else {
    if (event.reason === "manual_reply") return false;
    if (!prefs.handoffs) return false;
  }
  return !ctx.conversationInView;
}

/** ¿Notificación del sistema? Además exige maestro encendido y permiso. */
export function shouldNotify(
  event: AlertEvent,
  prefs: AlertPrefs,
  ctx: AlertContext
): boolean {
  if (!prefs.notifications) return false;
  if (ctx.permission !== "granted") return false;
  return isAlertWorthy(event, prefs, ctx);
}

/**
 * ¿Sonido? Independiente del permiso (RF-05-14: con las notificaciones
 * bloqueadas el sonido sigue funcionando). El throttle va aparte.
 */
export function shouldPlaySound(
  event: AlertEvent,
  prefs: AlertPrefs,
  ctx: Pick<AlertContext, "conversationInView">
): boolean {
  return prefs.sound && isAlertWorthy(event, prefs, ctx);
}

/** Clave de dedupe entre pestañas (RF-05-06); jamás el `id` del SSE. */
export function dedupeKey(event: AlertEvent): string {
  return event.kind === "message"
    ? `msg:${event.messageId}`
    : `handoff:${event.conversationId}:${event.handoffAt}`;
}

/** `tag` por conversación: los avisos seguidos se reemplazan, no se apilan. */
export function notificationTag(conversationId: string): string {
  return `conv:${conversationId}`;
}

/** `tag` de la notificación agregada de ráfagas de handoffs. */
export const AGGREGATE_HANDOFF_TAG = "handoff:aggregate";

export type NotificationText = { title: string; body: string };

export type ConversationInfo = {
  contactName: string | null;
  note?: string | null;
};

const GENERIC_MESSAGE = "Nuevo mensaje";
export const HANDOFF_TITLE = "Necesita atención humana";

export function notificationContent(
  event: AlertEvent,
  prefs: Pick<AlertPrefs, "showContent">,
  info: ConversationInfo
): NotificationText {
  const name = info.contactName?.trim() || null;
  if (event.kind === "message") {
    const preview = previewText(event.text?.trim() || event.type);
    return {
      title: name ?? GENERIC_MESSAGE,
      body: prefs.showContent && preview ? preview : GENERIC_MESSAGE,
    };
  }
  const label = handoffLabel(event.reason);
  const head = name ? `${name} — ${label}` : label;
  const note = info.note?.trim();
  return {
    title: HANDOFF_TITLE,
    body: prefs.showContent && note ? `${head}\n${note}` : head,
  };
}

/** Texto de la notificación agregada (ráfaga de handoffs). */
export function aggregateHandoffContent(count: number): NotificationText {
  return {
    title: `${count} conversaciones necesitan atención humana`,
    body: "Abre la Bandeja para atenderlas.",
  };
}

// ── Ráfagas de handoffs ─────────────────────────────────────────────────────

export type BurstDecision =
  | { kind: "single" }
  | { kind: "aggregate"; count: number };

/**
 * Si llegan más de `threshold` handoffs en `windowMs`, a partir del
 * `threshold + 1` se emite UNA notificación agregada (mismo `tag`, se
 * reemplaza con el conteo actualizado) en vez de una por conversación.
 */
export function createBurstAggregator(opts: {
  windowMs?: number;
  threshold?: number;
} = {}) {
  const windowMs = opts.windowMs ?? 10_000;
  const threshold = opts.threshold ?? 3;
  let stamps: number[] = [];
  return {
    push(now: number): BurstDecision {
      stamps = stamps.filter((t) => now - t < windowMs);
      stamps.push(now);
      return stamps.length > threshold
        ? { kind: "aggregate", count: stamps.length }
        : { kind: "single" };
    },
  };
}

// ── Dedupe y sonido ─────────────────────────────────────────────────────────

/** Conjunto acotado de claves ya avisadas (compartido por BroadcastChannel). */
export function createDedupe(opts: { ttlMs?: number; max?: number } = {}) {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const max = opts.max ?? 500;
  const seen = new Map<string, number>();
  const prune = (now: number) => {
    for (const [k, t] of seen) {
      if (now - t >= ttlMs) seen.delete(k);
    }
    while (seen.size > max) {
      const first = seen.keys().next();
      if (first.done) break;
      seen.delete(first.value);
    }
  };
  return {
    has(key: string, now: number): boolean {
      const t = seen.get(key);
      return t !== undefined && now - t < ttlMs;
    },
    mark(key: string, now: number): void {
      seen.delete(key);
      seen.set(key, now);
      prune(now);
    },
    get size() {
      return seen.size;
    },
  };
}

export const SOUND_MIN_GAP_MS = 3_000;

/** RF-05-09: máximo un sonido cada 3 s. */
export function soundAllowed(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= SOUND_MIN_GAP_MS;
}

// ── Coordinación entre pestañas ─────────────────────────────────────────────

/** Lo que cada pestaña anuncia de sí misma por `BroadcastChannel`. */
export type TabPresence = {
  tabId: string;
  visible: boolean;
  conversationId: string | null;
  at: number;
};

export const PRESENCE_STALE_MS = 45_000;

/** RF-05-04 visto desde la líder: ¿alguna pestaña visible la tiene abierta? */
export function isConversationInView(
  presences: Iterable<TabPresence>,
  conversationId: string,
  now: number,
  staleMs = PRESENCE_STALE_MS
): boolean {
  for (const p of presences) {
    if (now - p.at > staleMs) continue;
    if (p.visible && p.conversationId === conversationId) return true;
  }
  return false;
}

/**
 * Respaldo sin Web Locks: cada pestaña reclama la clave y, tras ~150 ms, gana
 * la de `tabId` menor entre los reclamos vistos (incluido el propio).
 */
export function wonClaim(myTabId: string, claimants: Iterable<string>): boolean {
  for (const id of claimants) {
    if (id < myTabId) return false;
  }
  return true;
}

// ── Título y favicon (RF-05-07/08) ──────────────────────────────────────────

const COUNT_PREFIX = /^\(\d+\+?\) /;

/** Quita el `(N) ` que hayamos puesto (idempotente). */
export function stripTitleCount(title: string): string {
  return title.replace(COUNT_PREFIX, "");
}

export function titleWithCount(base: string, n: number): string {
  const clean = stripTitleCount(base);
  if (!Number.isFinite(n) || n <= 0) return clean;
  const label = n > 99 ? "99+" : String(Math.floor(n));
  return `(${label}) ${clean}`;
}

/**
 * Pone `(N) ` en el título del documento solo si cambia (así reaplicarlo
 * desde un `MutationObserver` no entra en bucle). Devuelve si escribió.
 */
export function applyTitleCount(doc: { title: string }, n: number): boolean {
  const want = titleWithCount(doc.title, n);
  if (doc.title === want) return false;
  doc.title = want;
  return true;
}

/**
 * N del título a partir de lo que haya: `counts.unreadConversations` (06) o,
 * si `counts` aún no existe, la lista completa contando CONVERSACIONES con
 * no leídos (D-05-1). Payload inesperado → `null` (no tocar el título).
 */
export function unreadFromCounts(data: unknown): number | null {
  const n = (data as { unreadConversations?: unknown } | null)?.unreadConversations;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function unreadFromList(data: unknown): number | null {
  const list = (data as { conversations?: unknown } | null)?.conversations;
  if (!Array.isArray(list)) return null;
  let n = 0;
  for (const c of list) {
    const u = (c as { unreadCount?: unknown } | null)?.unreadCount;
    if (typeof u === "number" && u > 0) n += 1;
  }
  return n;
}

/** Punto del favicon (D-05-3): rojo con borde blanco, arriba a la derecha. */
export type BadgeDot = {
  cx: number;
  cy: number;
  r: number;
  ring: number;
  fill: string;
  stroke: string;
};

export const BADGE_COLOR = "#E5484D";

export function faviconBadgeDot(size: number): BadgeDot {
  const r = Math.round(size * 0.22);
  const ring = Math.max(1, Math.round(size * 0.06));
  return {
    cx: size - r - ring,
    cy: r + ring,
    r,
    ring,
    fill: BADGE_COLOR,
    stroke: "#FFFFFF",
  };
}

// ── Soporte del navegador (RF-05-14) ────────────────────────────────────────

export type NotificationSupport =
  | "unsupported"
  | "insecure"
  | "default"
  | "granted"
  | "denied";

export function notificationSupport(env: {
  hasNotification: boolean;
  isSecureContext: boolean;
  permission: NotificationPermission | null;
}): NotificationSupport {
  if (!env.hasNotification) return "unsupported";
  if (!env.isSecureContext) return "insecure";
  return env.permission ?? "default";
}
