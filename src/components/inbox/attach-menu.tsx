"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  MapPin,
  Mic,
  Paperclip,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { OutboundFileKind } from "@/lib/outbound-files";
import type { AttachKind } from "@/lib/attach-kinds";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<OutboundFileKind, LucideIcon> = {
  image: ImageIcon,
  document: FileText,
  video: Video,
  audio: Mic,
};

/**
 * 031 — Botón «Adjuntar» con su menú «¿Qué quieres mandar?»: un ítem por tipo
 * que el canal permite (formatos y tope a la vista ANTES de elegir) y, en
 * WhatsApp, «Enviar ubicación» y «Compartir contacto». Menú hecho a mano
 * (no hay librería de popover en el repo): flechas, Inicio/Fin, Esc y clic
 * fuera; al cerrar, el foco vuelve al botón.
 */
export function AttachMenu({
  kinds,
  officeNote,
  structured,
  hint,
  filesBlockedReason,
  disabled,
  activePanel,
  onPickKind,
  onLocation,
  onContact,
}: {
  kinds: AttachKind[];
  /** Pie «¿Un .doc o .xls antiguo?…» (solo si el canal acepta Office). */
  officeNote: boolean;
  /** Ubicación y contacto (solo WhatsApp). */
  structured: boolean;
  /** Qué acepta el canal, en una frase (`title` del botón). */
  hint: string | undefined;
  /** Si hay chips del catálogo, los archivos sueltos no se pueden elegir. */
  filesBlockedReason: string | null;
  disabled?: boolean;
  activePanel: "location" | "contact" | null;
  onPickKind: (kind: AttachKind) => void;
  onLocation: () => void;
  onContact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function items(): HTMLButtonElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      ) ?? []
    );
  }

  function close(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return;
    // Foco al primer ítem disponible al abrir.
    setTimeout(() => items()[0]?.focus(), 0);
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  const itemClass =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Adjuntar archivo"
        aria-haspopup="menu"
        aria-expanded={open}
        title={filesBlockedReason ?? hint}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex h-[34px] items-center gap-1.5 rounded-md border px-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 sm:px-2.5",
          (open || activePanel !== null) && "border-brand-soft bg-brand-tint text-brand-text"
        )}
      >
        <Paperclip className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        {/* A 360 px no caben tres botones con texto: queda el ícono. */}
        <span className="max-sm:sr-only">Adjuntar</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="¿Qué quieres mandar?"
          onKeyDown={onMenuKey}
          className="absolute bottom-full left-0 z-30 mb-2 flex w-[min(340px,calc(100vw-2.5rem))] flex-col rounded-lg border bg-popover p-1.5 shadow-pop"
        >
          <p aria-hidden className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-text-2">
            ¿Qué quieres mandar?
          </p>
          {kinds.map((k) => {
            const Icon = KIND_ICON[k.kind];
            const blocked = filesBlockedReason !== null;
            return (
              <button
                key={k.kind}
                type="button"
                role="menuitem"
                data-kind={k.kind}
                aria-disabled={blocked || undefined}
                title={blocked ? filesBlockedReason : undefined}
                onClick={() => {
                  if (blocked) return;
                  close(false);
                  onPickKind(k);
                }}
                className={itemClass}
              >
                <Icon className="h-[18px] w-[18px] shrink-0 text-brand-text" strokeWidth={1.7} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{k.label}</span>
                  <span className="text-xs text-text-2">
                    {/* El tope no se parte («hasta 100 / MB»). */}
                    {k.formats} · <span className="whitespace-nowrap">hasta {k.maxMb} MB</span>
                  </span>
                </span>
              </button>
            );
          })}
          {structured && (
            <>
              {kinds.length > 0 && <div aria-hidden className="mx-1 my-1 border-t" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false);
                  onLocation();
                }}
                className={itemClass}
              >
                <MapPin className="h-[18px] w-[18px] shrink-0 text-brand-text" strokeWidth={1.7} />
                <span className="font-semibold">Enviar ubicación</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false);
                  onContact();
                }}
                className={itemClass}
              >
                <UserRound className="h-[18px] w-[18px] shrink-0 text-brand-text" strokeWidth={1.7} />
                <span className="font-semibold">Compartir contacto</span>
              </button>
            </>
          )}
          {filesBlockedReason && kinds.length > 0 && (
            <p className="px-2.5 pb-1 pt-2 text-xs text-warning-text">{filesBlockedReason}</p>
          )}
          {officeNote && (
            <p className="mt-1 border-t px-2.5 pb-1.5 pt-2 text-xs text-text-2">
              ¿Un .doc o .xls antiguo? Ábrelo y guárdalo como .docx o .xlsx antes de
              mandarlo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
