"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  FlaskConical,
  Inbox,
  Kanban,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { Branding } from "@/lib/branding";
import type { ThemePreference } from "@/lib/theme";
import { NAV_COLLAPSED_COOKIE, NAV_COLLAPSED_COOKIE_MAX_AGE } from "@/lib/nav";
import { cn, initials } from "@/lib/utils";
import { signOut } from "@/lib/auth/client";
import { useEvents } from "@/components/use-events";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_VERSION, BUILD_COMMIT, versionLabel } from "@/lib/version";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Inbox;
  badge?: boolean;
};

const NAV: NavItem[] = [
  { href: "/inbox", label: "Bandeja", icon: Inbox, badge: true },
  { href: "/pipeline", label: "Pipeline", icon: Kanban },
  { href: "/contacts", label: "Contactos", icon: Users },
  { href: "/agent", label: "Agente", icon: Sparkles },
  { href: "/lab", label: "Laboratorio", icon: FlaskConical },
];

/** 015 — "Citas" solo existe si esta instancia encendió la agenda. */
const AGENDA_ITEM: NavItem = {
  href: "/bookings",
  label: "Citas",
  icon: CalendarDays,
};

export function AppNav({
  branding,
  userName,
  role,
  theme,
  initialCollapsed = false,
  commit,
  agenda = false,
  open = false,
  onClose,
}: {
  branding: Branding;
  userName: string;
  role: string;
  theme: ThemePreference;
  /**
   * Lateral contraído a solo iconos. Solo aplica en `lg+`: en móvil el cajón
   * se ve siempre completo, diga lo que diga la cookie.
   */
  initialCollapsed?: boolean;
  /**
   * Commit resuelto en el servidor. Gana al de build porque puede venir de la
   * plataforma cuando quien construyó no lo pasó como build-arg.
   */
  commit?: string;
  /**
   * 015 — ¿hay agenda en esta instancia? Viene del servidor por prop y no se
   * deduce de los datos: una instancia con la agenda encendida pero sin citas
   * todavía debe mostrar igual su pantalla.
   */
  agenda?: boolean;
  /** Solo aplica por debajo de `lg`: en escritorio el lateral es fijo. */
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggleCollapsed() {
    const value = !collapsed;
    setCollapsed(value);
    document.cookie = `${NAV_COLLAPSED_COOKIE}=${value ? "1" : "0"};path=/;max-age=${NAV_COLLAPSED_COOKIE_MAX_AGE};samesite=lax`;
  }

  async function refetchUnread() {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as {
      conversations: { unreadCount: number }[];
    };
    setUnread(data.conversations.reduce((a, c) => a + c.unreadCount, 0));
  }

  useEffect(() => {
    void refetchUnread();
  }, []);

  useEvents({
    onMessageNew: () => void refetchUnread(),
    onConversationUpdated: () => void refetchUnread(),
  });

  const sha = commit || BUILD_COMMIT;
  // Citas va después de Pipeline: es el paso siguiente de un trato, no una
  // sección aparte.
  const items = agenda
    ? [...NAV.slice(0, 2), AGENDA_ITEM, ...NAV.slice(2)]
    : NAV;

  return (
    <aside
      // Móvil: cajón que se desliza desde la izquierda (siempre montado, así
      // la transición corre en ambos sentidos). Escritorio: columna fija.
      // `visibility` va en la transición a propósito: al cerrar mantiene el
      // cajón visible mientras se desliza y recién entonces lo oculta, que es
      // lo que lo saca del orden de tabulación en móvil.
      // Contraído (solo lg+): 64px de iconos; el ancho se anima al alternar.
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-[17rem] shrink-0 flex-col overflow-y-auto border-r bg-subtle px-3 pb-3.5 pt-4 transition-[transform,visibility] duration-200",
        "lg:static lg:visible lg:z-auto lg:translate-x-0 lg:overflow-visible lg:transition-[width]",
        collapsed ? "lg:w-16 lg:px-2" : "lg:w-56",
        open ? "visible translate-x-0 shadow-pop" : "invisible -translate-x-full"
      )}
    >
      {/* Brand white-label */}
      <div
        className={cn(
          "mb-4 flex items-center gap-2.5 px-2",
          collapsed && "lg:flex-col lg:px-0"
        )}
      >
        {/* En móvil el cajón necesita su propio cierre: el velo no siempre es
            alcanzable con el pulgar. */}
        <button
          onClick={onClose}
          aria-label="Cerrar el menú"
          className="-ml-1 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:hidden"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-sm bg-brand text-[15px] font-bold text-brand-fg"
          aria-hidden
        >
          {branding.name.charAt(0).toUpperCase()}
        </span>
        <span className={cn("min-w-0", collapsed && "lg:hidden")}>
          <span className="block truncate text-[16px] font-[650] leading-tight tracking-tight">
            {branding.name}
          </span>
          <span className="block text-[11px] text-text-3">CRM · WhatsApp</span>
        </span>
        {/* Contraer/expandir: solo en escritorio, en móvil el cajón ya se
            cierra entero. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
          title={collapsed ? "Expandir menú" : "Contraer menú"}
          aria-expanded={!collapsed}
          className={cn(
            "hidden rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:inline-flex",
            !collapsed && "ml-auto"
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.7} />
          ) : (
            <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.7} />
          )}
        </button>
      </div>

      <nav className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const pending = item.badge && unread > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              // El nombre accesible no depende de la etiqueta visible: contraído
              // solo queda el icono.
              aria-label={pending ? `${item.label} (${unread} sin leer)` : item.label}
              title={collapsed ? item.label : undefined}
              className={cn(
                "relative flex items-center gap-[11px] rounded-sm px-2.5 py-2.5 text-sm font-medium transition-colors lg:py-2",
                collapsed && "lg:justify-center lg:px-0",
                active
                  ? "bg-brand-tint font-semibold text-brand-text"
                  : "text-text-2 hover:bg-accent"
              )}
            >
              <item.icon
                className={cn(
                  "h-[18px] w-[18px] shrink-0",
                  active ? "text-brand" : "text-text-3"
                )}
                strokeWidth={1.7}
              />
              <span className={cn("flex-1", collapsed && "lg:hidden")}>
                {item.label}
              </span>
              {pending && (
                <span
                  className={cn(
                    "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold",
                    // Contraído: contador pequeño encima de la esquina del icono.
                    collapsed &&
                      "lg:absolute lg:right-1 lg:top-0.5 lg:h-4 lg:min-w-4 lg:px-1 lg:text-[9.5px]",
                    active ? "bg-brand text-brand-fg" : "bg-border-strong text-text-2"
                  )}
                >
                  {unread}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <Link
        href="/settings"
        aria-label="Ajustes"
        title={collapsed ? "Ajustes" : undefined}
        className={cn(
          "flex items-center gap-[11px] rounded-sm px-2.5 py-2 text-sm font-medium transition-colors",
          collapsed && "lg:justify-center lg:px-0",
          pathname.startsWith("/settings")
            ? "bg-brand-tint font-semibold text-brand-text"
            : "text-text-2 hover:bg-accent"
        )}
      >
        <Settings
          className={cn(
            "h-[18px] w-[18px] shrink-0",
            pathname.startsWith("/settings") ? "text-brand" : "text-text-3"
          )}
          strokeWidth={1.7}
        />
        <span className={cn(collapsed && "lg:hidden")}>Ajustes</span>
      </Link>

      {/* Contraído, no caben en fila: avatar, tema y salir se apilan. */}
      <div
        className={cn(
          "mt-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2 hover:bg-accent",
          collapsed && "lg:flex-col lg:gap-1.5 lg:px-0"
        )}
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-text"
          title={collapsed ? userName : undefined}
        >
          {initials(userName)}
        </span>
        <span className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
          <span className="block truncate text-[13px] font-semibold">{userName}</span>
          <span className="block text-[11px] text-text-3">
            {role === "owner" ? "Propietario" : "Equipo"} · En línea
          </span>
        </span>
        <ThemeToggle initial={theme} />
        <button
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          className="rounded p-1 text-text-3 hover:text-foreground"
          onClick={async () => {
            await signOut();
            router.push("/login");
            router.refresh();
          }}
        >
          <LogOut className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>

      {/* Qué versión está corriendo. Discreta pero siempre visible: la duda
          "¿ya se desplegó?" aparece justo cuando algo no funciona, y mandar a
          alguien a comparar commits en el servidor significa que no lo hará. */}
      {/* `text-2` y no `text-3`: a 11px, el gris más claro se queda en 3.2:1
          contra el fondo de la barra y no pasa AA. Discreta sí, ilegible no. */}
      {/* El nombre sale de la marca, no de una constante: esto es white-label,
          y una instancia rebautizada que dice "Vocero" en el tooltip delata el
          producto de debajo justo donde el operador la mira todos los días. */}
      <p
        className={cn(
          "mt-1.5 px-2.5 text-[11px] tabular-nums text-text-2",
          // En 64px no cabe; contraído se oculta (expandir la muestra).
          collapsed && "lg:hidden"
        )}
        title={
          sha
            ? `${branding.name} ${APP_VERSION}, construido del commit ${sha}`
            : `${branding.name} ${APP_VERSION}`
        }
      >
        {versionLabel(sha)}
      </p>
    </aside>
  );
}
