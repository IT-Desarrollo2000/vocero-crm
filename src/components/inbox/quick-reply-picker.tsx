"use client";

import type { QuickReplyDto } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 09 — Selector de respuestas rápidas que abre `/` en el compositor. Solo
 * pinta: el teclado (↑/↓, Enter/Tab, Esc) lo maneja el `textarea`, que
 * conserva el foco; aquí se enlaza con `aria-activedescendant`.
 */
export const QUICK_REPLY_LISTBOX_ID = "quick-reply-listbox";

export function quickReplyOptionId(id: string): string {
  return `quick-reply-option-${id}`;
}

/** 029: id de la opción «+ Nueva respuesta rápida» (para `aria-activedescendant`). */
export const QUICK_REPLY_CREATE_OPTION_ID = "quick-reply-option-new";

export function QuickReplyPicker({
  matches,
  activeIndex,
  onHover,
  onPick,
  onCreate,
}: {
  matches: QuickReplyDto[];
  /** `matches.length` = la opción «+ Nueva respuesta rápida» (029). */
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (reply: QuickReplyDto) => void;
  /** 029: si viene, al final se ofrece «+ Nueva respuesta rápida». */
  onCreate?: () => void;
}) {
  // Sin coincidencias, Enter envía: no se resalta «+ Nueva…» (solo ratón).
  const createActive = matches.length > 0 && activeIndex === matches.length;
  return (
    <ul
      id={QUICK_REPLY_LISTBOX_ID}
      role="listbox"
      aria-label="Respuestas rápidas"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-md border bg-background p-1 shadow-pop"
    >
      {matches.map((r, i) => {
        const active = i === activeIndex;
        return (
          <li
            key={r.id}
            id={quickReplyOptionId(r.id)}
            role="option"
            aria-selected={active}
            // mousedown y no click: el textarea no debe perder el foco.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(r);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "cursor-pointer rounded px-2.5 py-1.5",
              active ? "bg-brand-tint" : "hover:bg-subtle"
            )}
          >
            <p className="flex items-baseline gap-2 text-[13px]">
              <span className="font-mono text-[12px] font-semibold text-brand-text">
                /{r.shortcut}
              </span>
              <span className="truncate font-medium">{r.title}</span>
            </p>
            <p className="truncate text-[11.5px] text-text-3">
              {/* 019: las ligadas a producto avisan cuántos archivos agregan. */}
              {r.product && r.product.files.length > 0
                ? `${r.product.files.length} ${r.product.files.length === 1 ? "archivo" : "archivos"} de ${r.product.name}${r.body ? ` · ${r.body}` : ""}`
                : r.body}
            </p>
          </li>
        );
      })}
      {onCreate && (
        <li
          id={QUICK_REPLY_CREATE_OPTION_ID}
          role="option"
          aria-selected={createActive}
          data-testid="quick-reply-create-option"
          onMouseDown={(e) => {
            e.preventDefault();
            onCreate();
          }}
          onMouseEnter={() => onHover(matches.length)}
          className={cn(
            "cursor-pointer rounded px-2.5 py-1.5 text-[13px] font-medium text-brand-text",
            matches.length > 0 && "mt-1 border-t pt-2",
            createActive ? "bg-brand-tint" : "hover:bg-subtle"
          )}
        >
          + Nueva respuesta rápida
        </li>
      )}
    </ul>
  );
}
