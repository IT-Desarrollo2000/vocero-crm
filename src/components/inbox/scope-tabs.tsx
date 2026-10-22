"use client";

import type { ConversationCounts, InboxScope } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 027: nombre de cada alcance (pestañas, aviso "ahora está en…"). */
export const SCOPE_LABEL: Record<InboxScope, string> = {
  inbox: "Buzón",
  mine: "Mis chats",
  team: "Equipo",
};

/** 027: pista al pasar el cursor (el Buzón incluye lo que el dueño contesta). */
const SCOPE_TITLE: Record<InboxScope, string> = {
  inbox: "Sin responsable; incluye los que contestas sin asignarte",
  mine: "Asignados a ti",
  team: "Asignados a otro miembro del equipo",
};

/**
 * 027 — Orden de las pestañas por rol: el Vendedor empieza por lo suyo (su
 * default); el Propietario, por el Buzón (su default) y luego lo del equipo.
 * El Vendedor no tiene "Equipo": no ve chats ajenos.
 */
export function scopeOrder(owner: boolean): InboxScope[] {
  return owner ? ["inbox", "team", "mine"] : ["mine", "inbox"];
}

/**
 * 027 — Selector de ALCANCE (Buzón · Mis chats · Equipo) encima de las vistas
 * de estado. Control segmentado de ancho completo (la columna de la lista ya
 * es toda la pantalla en móvil): cada pestaña reparte el ancho y su etiqueta
 * se recorta antes que desbordar (a 360 px no debe salir ningún
 * `button[aria-pressed]` de la pantalla, lo mide `e2e-alertas`).
 *
 * Cada pestaña dice su total (sin archivadas) y lleva un punto de acento si
 * tiene no leídas y no es la activa. Los números salen de `counts.scopes`
 * (no dependen de la búsqueda ni de los filtros).
 */
export function ScopeTabs({
  owner,
  active,
  scopes,
  searching,
  onChange,
}: {
  owner: boolean;
  /** Alcance ELEGIDO (la pestaña marcada), aunque la búsqueda lo suspenda. */
  active: InboxScope | null;
  scopes: ConversationCounts["scopes"] | undefined;
  /** Con texto en la búsqueda se busca en todos: las pestañas se atenúan. */
  searching: boolean;
  onChange: (scope: InboxScope) => void;
}) {
  const order = scopeOrder(owner);
  return (
    <div
      role="group"
      aria-label="Alcance de la Bandeja"
      className={cn(
        "grid w-full gap-1 rounded-md border bg-secondary p-1",
        order.length === 3 ? "grid-cols-3" : "grid-cols-2",
        searching && "opacity-60"
      )}
    >
      {order.map((s) => {
        const on = active === s;
        const total = scopes?.[s].all ?? 0;
        const dot = !on && (scopes?.[s].unread ?? 0) > 0;
        return (
          <button
            key={s}
            type="button"
            data-scope={s}
            aria-pressed={on}
            aria-label={`${SCOPE_LABEL[s]}: ${total}${dot ? ", con no leídas" : ""}`}
            title={SCOPE_TITLE[s]}
            onClick={() => onChange(s)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on
                ? "bg-background font-[650] text-foreground shadow-sm"
                : "font-medium text-text-2 hover:bg-accent hover:text-foreground"
            )}
          >
            <span className="truncate">{SCOPE_LABEL[s]}</span>
            <span
              className={cn(
                "shrink-0 text-[11.5px] tabular-nums",
                on ? "text-brand-text" : "text-text-3"
              )}
            >
              {total}
            </span>
            {dot && (
              <span
                aria-hidden
                data-testid="scope-unread-dot"
                className="h-[7px] w-[7px] shrink-0 rounded-full bg-brand"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
