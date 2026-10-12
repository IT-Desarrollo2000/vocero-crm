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

export function QuickReplyPicker({
  matches,
  activeIndex,
  onHover,
  onPick,
}: {
  matches: QuickReplyDto[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (reply: QuickReplyDto) => void;
}) {
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
            <p className="truncate text-[11.5px] text-text-3">{r.body}</p>
          </li>
        );
      })}
    </ul>
  );
}
