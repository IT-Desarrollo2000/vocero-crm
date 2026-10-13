"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  AGGREGATE_HANDOFF_TAG,
  aggregateHandoffContent,
  createBurstAggregator,
  dedupeKey,
  messageAlertEvent,
  notificationContent,
  notificationTag,
  shouldNotify,
  shouldPlaySound,
  type AlertEvent,
  type AlertPermission,
  type ConversationInfo,
} from "@/lib/alerts";
import { getAlertsCoordinator } from "@/components/alerts-coordinator";
import { playAlertSound } from "@/components/alert-sound";
import { brandIconHref } from "@/components/favicon-badge";
import { readAlertPrefs } from "@/components/use-alert-prefs";
import { useEvents } from "@/components/use-events";
import { useViewer } from "@/components/viewer-context";

/**
 * Notificaciones del navegador y sonido (RF-05-02..06, RF-05-09). Se monta
 * UNA vez por pestaña (dentro de `AppShell`, bajo `AlertsProvider`); solo la
 * pestaña líder avisa y cada evento avisa como máximo una vez entre todas
 * (`AlertsCoordinator.runOnce` con `dedupeKey`).
 *
 * - `message.new` entrante y `conversation.handoff` (salvo `manual_reply`).
 * - No avisa si alguna pestaña visible tiene esa conversación abierta (la
 *   Bandeja la informa con `reportOpenConversation`).
 * - Nombre del contacto y nota: `GET /api/conversations?ids=<id>` solo en la
 *   pestaña que va a avisar; si no vuelve (no visible), no se avisa.
 * - Ráfaga de handoffs (> 3 en 10 s) → una notificación agregada.
 * - Al reconectar el SSE no hay avisos retroactivos (no escucha onReconnect).
 */

export function currentPermission(): AlertPermission {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  if (!window.isSecureContext) return "unsupported";
  return Notification.permission;
}

type Lookup = (ConversationInfo & { contactId: string | null }) | "hidden" | null;

/** Datos para el texto y el clic; `"hidden"` = no es visible para quien mira. */
async function lookupConversation(conversationId: string): Promise<Lookup> {
  const res = await fetch(
    `/api/conversations?ids=${encodeURIComponent(conversationId)}`
  ).catch(() => null);
  if (!res) return null;
  if (res.status === 403 || res.status === 404) return "hidden";
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    conversations?: {
      id: string;
      contact?: { id?: string; name?: string };
      handoffNote?: string | null;
    }[];
  } | null;
  if (!data || !Array.isArray(data.conversations)) return null;
  // Con `ids` (06) llega solo esa; sin él, la lista completa: buscarla igual.
  const c = data.conversations.find((x) => x?.id === conversationId);
  if (!c) return "hidden";
  return {
    contactId: c.contact?.id ?? null,
    contactName: c.contact?.name ?? null,
    note: c.handoffNote ?? null,
  };
}

export function useInboxAlerts(): void {
  const { userId } = useViewer();
  const router = useRouter();
  const burst = useRef(createBurstAggregator());

  const show = useCallback(
    (title: string, body: string, tag: string, url: string) => {
      try {
        const n = new Notification(title, {
          body,
          tag,
          icon: brandIconHref(document),
          data: { url },
        });
        n.onclick = () => {
          window.focus();
          router.push(url);
          n.close();
        };
      } catch {
        // Android Chrome exige Service Worker para `new Notification`: sin
        // aviso, pero el título y el sonido siguen.
      }
    },
    [router]
  );

  const handle = useCallback(
    async (event: AlertEvent) => {
      const coord = getAlertsCoordinator();
      if (coord && !coord.isLeader()) return;
      const prefs = readAlertPrefs(userId);
      const ctx = {
        permission: currentPermission(),
        conversationInView: coord?.isConversationInView(event.conversationId) ?? false,
      };
      const notify = shouldNotify(event, prefs, ctx);
      const sound = shouldPlaySound(event, prefs, ctx);
      if (!notify && !sound) return;

      const work = async () => {
        let info: Lookup = null;
        if (notify) {
          info = await lookupConversation(event.conversationId);
          if (info === "hidden") return;
        }
        if (sound) playAlertSound();
        if (!notify) return;

        const contactId = info?.contactId ?? null;
        const url = contactId
          ? `/inbox?contact=${encodeURIComponent(contactId)}`
          : "/inbox";
        if (event.kind === "handoff") {
          const decision = burst.current.push(Date.now());
          if (decision.kind === "aggregate") {
            const text = aggregateHandoffContent(decision.count);
            show(text.title, text.body, AGGREGATE_HANDOFF_TAG, "/inbox");
            return;
          }
        }
        const text = notificationContent(event, prefs, {
          contactName: info?.contactName ?? null,
          note: info?.note ?? null,
        });
        show(text.title, text.body, notificationTag(event.conversationId), url);
      };

      if (coord) await coord.runOnce(dedupeKey(event), work);
      else await work();
    },
    [userId, show]
  );

  useEvents({
    onMessageNew: (data) => {
      const event = messageAlertEvent(data);
      if (event) void handle(event).catch(() => {});
    },
    onConversationHandoff: (data) => {
      if (
        typeof data?.conversationId !== "string" ||
        typeof data.reason !== "string" ||
        typeof data.handoffAt !== "string"
      ) {
        return;
      }
      void handle({
        kind: "handoff",
        conversationId: data.conversationId,
        reason: data.reason,
        handoffAt: data.handoffAt,
      }).catch(() => {});
    },
  });
}
