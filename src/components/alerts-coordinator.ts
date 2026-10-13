"use client";

import {
  createDedupe,
  isConversationInView,
  PRESENCE_STALE_MS,
  wonClaim,
  type TabPresence,
} from "@/lib/alerts";

/**
 * Coordinación de alertas entre pestañas del mismo navegador (dev-tasks/05,
 * RF-05-04 y RF-05-06). Un singleton por pestaña, arrancado por
 * `AlertsProvider` en `AppShell`:
 *
 * - Líder con Web Locks (`navigator.locks`): la pestaña que tiene el candado
 *   es la única que notifica y suena. Si la líder se cierra, el navegador
 *   pasa el candado a otra sola.
 * - Sin Web Locks: por evento, cada pestaña reclama la clave por
 *   `BroadcastChannel` y gana el `tabId` menor tras 150 ms.
 * - Sin ninguno de los dos: cada pestaña decide sola (el `tag` de la
 *   notificación evita que el sistema operativo las apile).
 * - Dedupe compartido: quien avisa difunde la clave y todas la recuerdan,
 *   así un cambio de líder no repite el aviso.
 * - Presencia: cada pestaña difunde si está visible y qué conversación tiene
 *   abierta, para que la líder no avise de lo que alguien ya está viendo.
 */

const CHANNEL = "vocero:alerts";
const LOCK = "vocero:alerts:leader";
const CLAIM_WAIT_MS = 150;
const HEARTBEAT_MS = 15_000;

type Msg =
  | { t: "presence"; p: TabPresence }
  | { t: "bye"; tabId: string }
  | { t: "who" }
  | { t: "seen"; key: string }
  | { t: "claim"; key: string; tabId: string };

export type AlertsCoordinator = {
  readonly tabId: string;
  /** ¿Esta pestaña decide los avisos? (con Web Locks, solo una). */
  isLeader(): boolean;
  /** La Bandeja informa la conversación abierta (null = ninguna). */
  setOpenConversation(conversationId: string | null): void;
  /** RF-05-04 con la presencia de todas las pestañas (incluida esta). */
  isConversationInView(conversationId: string): boolean;
  /**
   * Ejecuta `fn` como máximo una vez entre todas las pestañas para `key`.
   * Resuelve `true` si esta pestaña lo ejecutó.
   */
  runOnce(key: string, fn: () => void | Promise<void>): Promise<boolean>;
  stop(): void;
};

function newTabId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${rnd}`;
}

export function createAlertsCoordinator(): AlertsCoordinator {
  const tabId = newTabId();
  const dedupe = createDedupe();
  const presences = new Map<string, TabPresence>();
  const claims = new Map<string, Set<string>>();
  let openConversation: string | null = null;
  let leader = false;
  let stopped = false;

  const hasLocks =
    typeof navigator !== "undefined" &&
    "locks" in navigator &&
    typeof navigator.locks?.request === "function";
  let channel: BroadcastChannel | null = null;
  try {
    channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    channel = null;
  }

  const post = (msg: Msg) => {
    try {
      channel?.postMessage(msg);
    } catch {
      // Canal cerrado: la pestaña sigue sola.
    }
  };

  const ownPresence = (): TabPresence => ({
    tabId,
    visible: typeof document === "undefined" || document.visibilityState === "visible",
    conversationId: openConversation,
    at: Date.now(),
  });
  const announce = () => {
    const p = ownPresence();
    presences.set(tabId, p);
    post({ t: "presence", p });
  };

  if (channel) {
    channel.onmessage = (ev: MessageEvent<Msg>) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      switch (msg.t) {
        case "presence":
          presences.set(msg.p.tabId, msg.p);
          break;
        case "bye":
          presences.delete(msg.tabId);
          break;
        case "who":
          announce();
          break;
        case "seen":
          dedupe.mark(msg.key, Date.now());
          break;
        case "claim": {
          // Reclamos de claves que esta pestaña nunca procesó: acotar.
          if (claims.size > 500) claims.clear();
          const set = claims.get(msg.key);
          if (set) set.add(msg.tabId);
          else claims.set(msg.key, new Set([msg.tabId]));
          break;
        }
      }
    };
  }

  // Líder por Web Locks: el candado se retiene hasta cerrar la pestaña.
  let releaseLock: (() => void) | null = null;
  if (hasLocks) {
    void navigator.locks
      .request(LOCK, () => {
        if (stopped) return;
        leader = true;
        // Recién llegada al mando: pedir presencia a las demás.
        post({ t: "who" });
        return new Promise<void>((resolve) => {
          releaseLock = () => {
            leader = false;
            resolve();
          };
        });
      })
      .catch(() => {
        leader = false;
      });
  }

  const onVisibility = () => announce();
  const onHide = () => post({ t: "bye", tabId });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onHide);
  }
  const heartbeat = setInterval(announce, HEARTBEAT_MS);
  announce();
  post({ t: "who" });

  const execute = async (key: string, fn: () => void | Promise<void>) => {
    dedupe.mark(key, Date.now());
    post({ t: "seen", key });
    await fn();
    return true;
  };

  return {
    tabId,
    isLeader: () => (hasLocks ? leader : true),
    setOpenConversation(conversationId) {
      if (openConversation === conversationId) return;
      openConversation = conversationId;
      announce();
    },
    isConversationInView(conversationId) {
      presences.set(tabId, ownPresence());
      return isConversationInView(
        presences.values(),
        conversationId,
        Date.now(),
        PRESENCE_STALE_MS
      );
    },
    async runOnce(key, fn) {
      if (stopped || dedupe.has(key, Date.now())) return false;
      if (hasLocks) {
        if (!leader) return false;
        return execute(key, fn);
      }
      if (!channel) return execute(key, fn);
      // Respaldo: reclamo y desempate por `tabId` menor.
      const set = claims.get(key) ?? new Set<string>();
      set.add(tabId);
      claims.set(key, set);
      post({ t: "claim", key, tabId });
      await new Promise((r) => setTimeout(r, CLAIM_WAIT_MS));
      const claimants = claims.get(key) ?? new Set([tabId]);
      claims.delete(key);
      if (dedupe.has(key, Date.now()) || !wonClaim(tabId, claimants)) return false;
      return execute(key, fn);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      post({ t: "bye", tabId });
      releaseLock?.();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onHide);
      }
      try {
        channel?.close();
      } catch {
        // ya cerrado
      }
    },
  };
}

let current: AlertsCoordinator | null = null;
let refs = 0;
let pendingOpen: string | null = null;

/** Arranca (o reutiliza) el coordinador de la pestaña. Devuelve cómo soltarlo. */
export function acquireAlertsCoordinator(): () => void {
  if (!current) {
    current = createAlertsCoordinator();
    if (pendingOpen) current.setOpenConversation(pendingOpen);
  }
  refs += 1;
  return () => {
    refs -= 1;
    if (refs <= 0 && current) {
      current.stop();
      current = null;
      refs = 0;
    }
  };
}

export function getAlertsCoordinator(): AlertsCoordinator | null {
  return current;
}

/**
 * Punto de enganche de la Bandeja (05-inbox): informar qué conversación está
 * abierta en esta pestaña, o `null` al cerrarla/salir de la Bandeja.
 */
export function reportOpenConversation(conversationId: string | null): void {
  pendingOpen = conversationId;
  current?.setOpenConversation(conversationId);
}
