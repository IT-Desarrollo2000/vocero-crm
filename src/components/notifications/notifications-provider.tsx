"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  NOTIFICATION_KINDS,
  TOAST_MAX,
  browserNotificationCopy,
  type NotificationDto,
  type NotificationListDto,
} from "@/lib/notifications";
import { shouldNotifyReminder } from "@/lib/alerts";
import type { PostponePreset } from "@/lib/follow-ups";
import { getAlertsCoordinator } from "@/components/alerts-coordinator";
import { brandIconHref } from "@/components/favicon-badge";
import { readAlertPrefs } from "@/components/use-alert-prefs";
import { currentPermission } from "@/components/use-inbox-alerts";
import { useEvents } from "@/components/use-events";
import { useViewer } from "@/components/viewer-context";
import { notifyFollowUpsChanged, useFollowUpsChanged } from "@/components/follow-ups/follow-up-events";
import { ReminderToasts } from "./reminder-toasts";

/**
 * 035 B — Los avisos de QUIEN MIRA, una vez por pestaña (montado en
 * `AppShell`, dentro de `AlertsProvider`): las dos campanas (lateral y
 * encabezado móvil) leen de aquí, así no se pide la lista dos veces.
 *
 * - `GET /api/notifications` al montar, al volver a la pestaña, cada 2 min y
 *   al reconectar el SSE (catch-up: el servidor no garantiza replay).
 * - SSE `notification.changed` (solo llega el propio): `new` → recarga y, si
 *   es un recordatorio vencido, aviso emergente (máx. 3); `read` → recarga y
 *   quita su emergente.
 * - SSE `follow_ups.changed` → se reenvía como el evento de ventana de la
 *   fase A (número rojo, Pendientes, línea de la Bandeja) y se recarga.
 * - Navegador: con la pestaña oculta, la pestaña líder lanza `Notification`
 *   (una vez entre pestañas: `runOnce` con el id del aviso).
 */

const POLL_MS = 2 * 60_000;

type Ctx = {
  data: NotificationListDto | null;
  unread: number;
  refresh: () => void;
  markRead: (ids: string[]) => Promise<void>;
  markAll: () => Promise<boolean>;
  postpone: (n: NotificationDto, preset: PostponePreset) => Promise<boolean>;
  toasts: NotificationDto[];
  dismissToast: (id: string) => void;
};

const NotificationsContext = createContext<Ctx | null>(null);

export function useNotifications(): Ctx | null {
  return useContext(NotificationsContext);
}

/** Enlace para escribirle: su chat si lo tiene; si no, buscarlo en Contactos. */
export function contactLink(n: NotificationDto): string {
  const name = n.contact?.name ?? n.payload.contactName ?? "";
  const conv = n.followUp?.conversationId ?? n.conversationId;
  if (n.contact && conv) return `/inbox?contact=${encodeURIComponent(n.contact.id)}`;
  return `/contacts?q=${encodeURIComponent(name)}`;
}

/** A dónde lleva un aviso (clic en la notificación del navegador). */
export function notificationLink(n: NotificationDto): string {
  switch (n.kind) {
    case "follow_up_due":
    case "chat_assigned":
      return contactLink(n);
    case "booking_assigned":
      return "/bookings";
    case "daily_summary":
      return "/pipeline?vista=pendientes";
  }
}

/** El DTO que viaja en el SSE, o `null` si no trae lo necesario. */
function parseDto(raw: unknown): NotificationDto | null {
  const n = raw as Partial<NotificationDto> | null;
  if (!n || typeof n !== "object" || typeof n.id !== "string") return null;
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(String(n.kind))) return null;
  return { ...(n as NotificationDto), payload: n.payload ?? {} };
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useViewer();
  const router = useRouter();
  const [data, setData] = useState<NotificationListDto | null>(null);
  const [toasts, setToasts] = useState<NotificationDto[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/notifications").catch(() => null);
    if (!res?.ok) return;
    const json = (await res.json().catch(() => null)) as NotificationListDto | null;
    if (json && Array.isArray(json.notifications)) setData(json);
  }, []);

  // Varios eventos seguidos (un tick con vencido + resumen) = una recarga.
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, 120);
  }, [load]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // Un recordatorio cambió en ESTA pestaña (Pendientes, diálogo): su aviso
  // pudo quedar leído o «Ya lo marcaste como hecho».
  useFollowUpsChanged(refresh);

  const showBrowser = useCallback(
    async (n: NotificationDto) => {
      const coord = getAlertsCoordinator();
      if (coord && !coord.isLeader()) return;
      const prefs = readAlertPrefs(userId);
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!shouldNotifyReminder(prefs, { permission: currentPermission(), hidden })) return;
      const text = browserNotificationCopy(n, {
        now: new Date(),
        tz: data?.businessTimezone ?? "America/Mexico_City",
      });
      if (!text) return;
      const url = notificationLink(n);
      const work = () => {
        try {
          const note = new Notification(text.title, {
            body: text.body,
            tag: `ntf:${n.id}`,
            icon: brandIconHref(document),
            data: { url },
          });
          note.onclick = () => {
            window.focus();
            router.push(url);
            note.close();
          };
        } catch {
          // Android Chrome exige Service Worker: sin aviso del sistema, pero
          // la campana y el emergente siguen.
        }
      };
      if (coord) await coord.runOnce(`ntf:${n.id}`, work);
      else work();
    },
    [userId, router, data?.businessTimezone]
  );

  useEvents({
    onNotificationChanged: (ev) => {
      if (!ev || ev.userId !== userId) return;
      refresh();
      if (ev.reason === "new") {
        const n = parseDto(ev.notification);
        if (!n) return;
        if (n.kind === "follow_up_due") {
          setToasts((prev) => [...prev.filter((t) => t.id !== n.id), n].slice(-TOAST_MAX));
        }
        void showBrowser(n).catch(() => {});
      } else if (ev.reason === "read") {
        if (ev.all) setToasts([]);
        else if (Array.isArray(ev.ids)) {
          const gone = new Set(ev.ids);
          setToasts((prev) => prev.filter((t) => !gone.has(t.id)));
        }
      }
    },
    onFollowUpsChanged: (ev) => {
      if (!ev || !Array.isArray(ev.userIds) || !ev.userIds.includes(userId)) return;
      // El mismo camino de la fase A: número rojo, Pendientes y la Bandeja.
      notifyFollowUpsChanged();
    },
    onReconnect: refresh,
  });

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      // Optimista: el punto se apaga ya; la recarga confirma.
      setData((d) =>
        d
          ? {
              ...d,
              unread: Math.max(0, d.unread - d.notifications.filter((n) => ids.includes(n.id) && !n.readAt).length),
              notifications: d.notifications.map((n) =>
                ids.includes(n.id) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n
              ),
            }
          : d
      );
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
        keepalive: true,
      }).catch(() => null);
      refresh();
    },
    [refresh]
  );

  const markAll = useCallback(async () => {
    const res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => null);
    await load();
    return !!res?.ok;
  }, [load]);

  const postpone = useCallback(
    async (n: NotificationDto, preset: PostponePreset) => {
      if (!n.followUpId) return false;
      const res = await fetch(`/api/follow-ups/${encodeURIComponent(n.followUpId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "postpone", preset }),
      }).catch(() => null);
      if (!res?.ok) return false;
      // El servidor ya lo marcó leído (y lo avisa por SSE); aquí, al instante.
      setToasts((prev) => prev.filter((t) => t.id !== n.id));
      notifyFollowUpsChanged();
      refresh();
      return true;
    },
    [refresh]
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      data,
      unread: data?.unread ?? 0,
      refresh,
      markRead,
      markAll,
      postpone,
      toasts,
      dismissToast,
    }),
    [data, refresh, markRead, markAll, postpone, toasts, dismissToast]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <ReminderToasts />
    </NotificationsContext.Provider>
  );
}
