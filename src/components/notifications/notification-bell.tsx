"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { POSTPONE_PRESETS, type PostponePreset } from "@/lib/follow-ups";
import { agoLabel, notificationCopy, type NotificationDto } from "@/lib/notifications";
import { useAlertsActivation } from "@/components/alerts-menu";
import { contactLink, useNotifications } from "./notifications-provider";

/**
 * 035 B — La campana junto al nombre del negocio (lateral en escritorio,
 * encabezado en el celular) y su panel «Avisos».
 *
 * El panel es un diálogo NO modal: Escape o un clic fuera lo cierran, el foco
 * entra al abrirlo, Tab no se sale de él y al cerrar vuelve a la campana. Va
 * en un portal a `body`: el lateral tiene `transform` y `overflow`, que lo
 * recortarían.
 */

const PANEL_W = 400;
const POSTPONE_SHORT: Record<PostponePreset, string> = {
  "1h": "1 hora",
  tomorrow: "Mañana",
  week: "1 semana",
};

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NotificationBell({ testId, className }: { testId: string; className?: string }) {
  const ctx = useNotifications();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const unread = ctx?.unread ?? 0;

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const vw = window.innerWidth;
    const width = Math.min(PANEL_W, vw - 16);
    const left = Math.max(8, Math.min(b.left - 20, vw - width - 8));
    setPos({ top: b.bottom + 8, left, width });
  }, []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, place]);

  // Al abrir: recargar (el resumen es en vivo) y llevar el foco adentro.
  useEffect(() => {
    if (!open) return;
    ctx?.refresh();
    // El foco entra al diálogo (sin pintar un anillo en el primer botón);
    // Tab sigue a lo primero de adentro.
    const t = setTimeout(() => panelRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!panelRef.current.contains(active) || active === panelRef.current) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!ctx) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        aria-label={unread > 0 ? `Avisos: ${unread} sin leer` : "Avisos"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open
            ? "border-brand-soft bg-brand-tint text-brand-text"
            : "border-border bg-background text-text-2 hover:bg-accent hover:text-foreground",
          className
        )}
      >
        <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span
            data-testid={`${testId}-count`}
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-[3px] text-[10px] font-bold leading-none text-destructive-foreground"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <NotificationsPanel
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            onNavigate={() => close(false)}
          />,
          document.body
        )}
    </>
  );
}

type PanelProps = { style: React.CSSProperties; onNavigate: () => void };

function NotificationsPanel({
  ref,
  style,
  onNavigate,
}: PanelProps & { ref: React.Ref<HTMLElement> }) {
  const ctx = useNotifications()!;
  const data = ctx.data;
  const [now, setNow] = useState(() => new Date());
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = data?.notifications ?? [];
  const tz = data?.businessTimezone ?? "America/Mexico_City";

  return (
    <section
      ref={ref}
      role="dialog"
      aria-labelledby="avisos-titulo"
      data-testid="notifications-panel"
      tabIndex={-1}
      style={style}
      className="fixed z-[80] flex outline-none max-h-[calc(100dvh-5rem)] flex-col rounded-lg border border-border-strong bg-background text-foreground shadow-pop print:hidden"
    >
      <header className="flex items-center gap-2 border-b px-3.5 py-3">
        <h2 id="avisos-titulo" className="flex-1 text-[15px] font-semibold">
          Avisos
        </h2>
        {ctx.unread > 0 && (
          <button
            type="button"
            data-testid="notifications-read-all"
            onClick={async () => {
              setNotice(null);
              if (!(await ctx.markAll())) setNotice("No se pudieron marcar. Vuelve a intentarlo.");
            }}
            className="min-h-8 rounded px-1.5 text-[12.5px] text-brand-text underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Marcar todo como leído
          </button>
        )}
      </header>
      {notice && (
        <p role="status" className="border-b px-3.5 py-2 text-[12.5px] text-danger-text">
          {notice}
        </p>
      )}
      {!data ? (
        <p className="px-3.5 py-6 text-[13px] text-text-2">Cargando avisos…</p>
      ) : items.length === 0 ? (
        <p data-testid="notifications-empty" className="px-3.5 py-6 text-[13px] text-text-2">
          No tienes avisos. Aquí aparecerán tus recordatorios vencidos, tu resumen del día y lo que te asignen.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col overflow-y-auto">
          {items.map((n, i) => (
            <NotificationItem
              key={n.id}
              n={n}
              now={now}
              tz={tz}
              last={i === items.length - 1}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      <BrowserFooter />
    </section>
  );
}

function NotificationItem({
  n,
  now,
  tz,
  last,
  onNavigate,
}: {
  n: NotificationDto;
  now: Date;
  tz: string;
  last: boolean;
  onNavigate: () => void;
}) {
  const ctx = useNotifications()!;
  const copy = notificationCopy(n, { now, tz, summary: ctx.data?.summary ?? { today: 0, overdue: 0 } });
  const unread = !n.readAt;
  const strong = unread && !copy.muted;
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const read = () => {
    if (unread) void ctx.markRead([n.id]);
  };
  const go = () => {
    read();
    onNavigate();
  };
  // Acciones de un recordatorio todavía abierto y sin tocar.
  const actionable = n.kind === "follow_up_due" && unread && !copy.state && !!n.followUp;

  const linkCls = "font-medium text-brand-text underline underline-offset-2 hover:text-foreground";

  return (
    <li
      data-testid="notification-item"
      data-kind={n.kind}
      data-unread={unread ? "1" : "0"}
      onClick={(e) => {
        // Clic en la fila (no en un botón o enlace) = leído.
        if ((e.target as HTMLElement).closest("a,button")) return;
        read();
      }}
      className={cn(
        "flex gap-2.5 px-3.5 py-3",
        !last && "border-b",
        unread && (copy.tone === "danger" ? "bg-danger-tint" : "bg-brand-tint")
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          unread && (copy.tone === "danger" ? "bg-danger" : "bg-brand")
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {unread && <span className="sr-only">Sin leer.</span>}
        <p
          data-testid="notification-text"
          className={cn("break-words text-[13.5px]", (!unread || copy.muted) && "text-text-2")}
        >
          {copy.lead ? (
            <>
              {strong ? <strong className="font-semibold">{copy.lead}</strong> : copy.lead}
              {copy.title && !copy.title.startsWith(" ") ? " " : ""}
              {copy.title}
            </>
          ) : strong ? (
            <strong className="font-semibold">{copy.title}</strong>
          ) : (
            copy.title
          )}
        </p>
        {unread ? (
          <>
            {copy.detail && (
              <p className="break-words text-[12.5px] text-text-2">
                {copy.detail}
                {n.kind === "chat_assigned" && (
                  <>
                    {" · "}
                    <Link href={contactLink(n)} onClick={go} className={linkCls}>
                      Abrir chat
                    </Link>
                  </>
                )}
                {n.kind === "booking_assigned" && (
                  <>
                    {" · "}
                    <Link href="/bookings" onClick={go} className={linkCls}>
                      Ver cita
                    </Link>
                  </>
                )}
              </p>
            )}
            {n.kind === "daily_summary" && (
              <Link href="/pipeline?vista=pendientes" onClick={go} className={cn("self-start text-[12.5px]", linkCls)}>
                Ver en Seguimiento › Pendientes
              </Link>
            )}
            {copy.state && <p className="text-[12.5px] text-text-2">{copy.state}</p>}
            {failed && <p className="text-[12.5px] text-danger-text">No se pudo posponer. Vuelve a intentarlo.</p>}
            {actionable && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Link
                  href={contactLink(n)}
                  onClick={go}
                  className="inline-flex min-h-[34px] items-center rounded-sm bg-primary px-2.5 text-[12.5px] font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Contactar
                </Link>
                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    aria-expanded={menu}
                    aria-haspopup="menu"
                    disabled={busy}
                    onClick={() => setMenu((v) => !v)}
                    className="inline-flex min-h-[34px] items-center rounded-sm border border-border-strong bg-background px-2.5 text-[12.5px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    Posponer ▾
                  </button>
                  {menu && (
                    <div role="menu" className="absolute left-0 z-10 mt-1 flex w-40 flex-col rounded-md border bg-background p-1 shadow-pop">
                      {POSTPONE_PRESETS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          role="menuitem"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setFailed(false);
                            const ok = await ctx.postpone(n, p);
                            setBusy(false);
                            setMenu(false);
                            if (!ok) setFailed(true);
                          }}
                          className="rounded px-2.5 py-2 text-left text-[13px] hover:bg-accent"
                        >
                          {POSTPONE_SHORT[p]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-[12.5px] text-text-3">
            {copy.state ?? `Leído · ${agoLabel(n.createdAt, now, tz)}`}
          </p>
        )}
      </div>
    </li>
  );
}

/** Pie: avisos del navegador (por usuario y dispositivo). */
function BrowserFooter() {
  const { prefs, update, support, ready, asking, activate, notice } = useAlertsActivation();
  if (!ready) return <footer className="h-[58px] rounded-b-lg border-t bg-subtle" />;
  const on = support === "granted" && prefs.notifications && prefs.reminders;

  let text: string;
  let action: React.ReactNode = null;
  const btnCls =
    "inline-flex min-h-[34px] items-center rounded-sm border border-brand-soft bg-background px-2.5 text-[12.5px] font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
  if (support === "unsupported" || support === "insecure") {
    text =
      support === "insecure"
        ? "Los avisos fuera de esta pestaña solo funcionan con https://. La campana y el aviso emergente siguen funcionando."
        : "Este navegador no permite avisos fuera de la pestaña. La campana y el aviso emergente siguen funcionando.";
  } else if (support === "denied") {
    text =
      "Bloqueaste los avisos en este navegador. Para permitirlos, toca el candado junto a la dirección, busca «Notificaciones» y elige «Permitir».";
  } else if (on) {
    text = "Avisos del navegador activados";
    action = (
      <button type="button" data-testid="browser-alerts-off" onClick={() => update({ reminders: false })} className={btnCls}>
        Desactivar
      </button>
    );
  } else {
    text = "¿Quieres el aviso aunque estés en otra pestaña?";
    action = (
      <button
        type="button"
        data-testid="browser-alerts-on"
        disabled={asking}
        onClick={() => {
          if (support === "granted") update({ notifications: true, reminders: true });
          else {
            update({ reminders: true });
            void activate();
          }
        }}
        className={btnCls}
      >
        Activar avisos del navegador
      </button>
    );
  }
  return (
    <footer className="flex flex-wrap items-center gap-2.5 rounded-b-lg border-t bg-subtle px-3.5 py-3">
      <p data-testid="browser-alerts-state" className="flex-[1_1_200px] text-[12.5px] text-text-2">
        {text}
        {notice && <span className="block text-warning-text">{notice}</span>}
      </p>
      {action}
    </footer>
  );
}
