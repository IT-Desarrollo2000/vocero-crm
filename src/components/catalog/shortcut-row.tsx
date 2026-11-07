"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/**
 * 032 — Un atajo del producto (`/fotos_t03`) con lo que manda y «Copiar».
 * Sin portapapeles (origen sin HTTPS o permiso negado) lo dice en texto:
 * el vendedor lo escribe a mano. El aviso va en `aria-live` para lectores.
 */
export function ShortcutRow({
  shortcut,
  sends,
  className,
}: {
  /** Sin la barra. */
  shortcut: string;
  /** «las 2 fotos», «la ficha»… */
  sends?: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const text = `/${shortcut}`;

  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  function copy() {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) {
      setState("failed");
      return;
    }
    clip.writeText(text).then(
      () => setState("copied"),
      () => setState("failed")
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="catalog-shortcut" data-shortcut={shortcut}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card py-1 pl-2.5 pr-1">
        <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-foreground">{text}</code>
        {sends && <span className="text-xs text-text-2">{sends}</span>}
        <button
          type="button"
          onClick={copy}
          aria-label={`Copiar ${text}`}
          className="rounded-md border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {state === "copied" ? "Copiado" : "Copiar"}
        </button>
      </div>
      <p aria-live="polite" className={cn("text-xs", state === "failed" ? "mt-1 text-warning-text" : "sr-only")}>
        {state === "failed"
          ? `No se pudo copiar: escribe ${text} en el chat.`
          : state === "copied"
            ? `${text} copiado`
            : ""}
      </p>
    </div>
  );
}
