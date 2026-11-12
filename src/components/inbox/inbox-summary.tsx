"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { SummaryItem } from "@/lib/inbox-summary";
import { cn } from "@/lib/utils";
import { firstName } from "@/lib/quick-replies";

/**
 * 031 — Panel derecho sin chat abierto: saludo y lo que toca ahora. Cada
 * acceso lleva a una vista que ya existe (Por atender, filtro Por cerrar,
 * Buzón); sin pendientes, «Todo al día».
 */
export function InboxSummary({
  viewerName,
  items,
  onGo,
}: {
  viewerName: string;
  items: SummaryItem[];
  onGo: (id: SummaryItem["id"]) => void;
}) {
  const first = firstName(viewerName);
  return (
    <div className="flex flex-1 items-center justify-center bg-chat p-6">
      <div
        data-testid="inbox-summary"
        className="w-full max-w-[520px] space-y-4 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{first ? `Hola, ${first}` : "Hola"}</h2>
          <p className="text-sm text-text-2">
            {items.length > 0 ? "Esto es lo que te toca ahora:" : "Todo al día. Cuando un cliente escriba, aparecerá aquí."}
          </p>
        </div>
        {items.length > 0 && (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  data-testid={it.id === "inbox" ? "inbox-reminder" : `summary-${it.id}`}
                  onClick={() => onGo(it.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    it.tone === "danger" && "border-danger-soft bg-danger-tint hover:border-danger",
                    it.tone === "warning" && "border-warning-soft bg-warning-tint hover:border-warning",
                    it.tone === "accent" && "border-brand-soft bg-brand-tint hover:border-brand",
                    it.tone === "neutral" && "hover:bg-subtle"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-[30px] min-w-[30px] shrink-0 items-center justify-center rounded-full px-1.5 text-sm font-bold tabular-nums",
                      it.tone === "danger" && "bg-background text-danger-text",
                      it.tone === "warning" && "bg-background text-warning-text",
                      it.tone === "accent" && "bg-background text-brand-text",
                      it.tone === "neutral" && "bg-secondary text-text-2"
                    )}
                  >
                    {it.count}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="text-sm font-semibold text-foreground">{it.title}</strong>
                    <span className="text-[13px] text-text-2">{it.hint}</span>
                  </span>
                  <ArrowRight
                    aria-hidden
                    className={cn(
                      "h-4 w-4 shrink-0",
                      it.tone === "danger"
                        ? "text-danger-text"
                        : it.tone === "warning"
                          ? "text-warning-text"
                          : it.tone === "accent"
                            ? "text-brand"
                            : "text-text-3"
                    )}
                    strokeWidth={1.8}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-text-2">
          ¿Dudas? Abre{" "}
          <Link href="/ayuda" className="font-medium text-brand-text underline underline-offset-2">
            Ayuda
          </Link>{" "}
          en el menú.
        </p>
      </div>
    </div>
  );
}
