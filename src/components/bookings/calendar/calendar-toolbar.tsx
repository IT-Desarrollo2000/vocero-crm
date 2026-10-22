"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CalView } from "./calendar-model";

/**
 * 028 — Barra del calendario: vista (Semana | Día | Lista), ‹ Hoy ›, el título
 * del rango y los interruptores de canceladas y pruebas. En la Lista solo se
 * ve el selector: la Lista se conserva tal cual (US-3).
 */

const VIEW_BUTTONS: { view: CalView; label: string; testId: string }[] = [
  { view: "semana", label: "Semana", testId: "cal-view-week" },
  { view: "dia", label: "Día", testId: "cal-view-day" },
  { view: "lista", label: "Lista", testId: "cal-view-list" },
];

export function CalendarToolbar({
  view,
  title,
  showCancelled,
  showTests,
  onView,
  onPrev,
  onNext,
  onToday,
  onShowCancelled,
  onShowTests,
}: {
  view: CalView;
  title: string;
  showCancelled: boolean;
  showTests: boolean;
  onView: (v: CalView) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onShowCancelled: (v: boolean) => void;
  onShowTests: (v: boolean) => void;
}) {
  const calendar = view !== "lista";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="Vista"
        className="inline-flex rounded-md border p-0.5"
      >
        {VIEW_BUTTONS.map((b) => (
          <button
            key={b.view}
            type="button"
            data-testid={b.testId}
            aria-pressed={view === b.view}
            onClick={() => onView(b.view)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-sm transition-colors",
              view === b.view
                ? "bg-brand-tint font-medium text-brand-text"
                : "text-text-2 hover:bg-accent"
            )}
          >
            {b.label}
          </button>
        ))}
      </div>

      {calendar && (
        <>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="cal-prev"
              aria-label={view === "semana" ? "Semana anterior" : "Día anterior"}
              onClick={onPrev}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Button>
            <Button size="sm" variant="secondary" data-testid="cal-today" onClick={onToday}>
              Hoy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="cal-next"
              aria-label={view === "semana" ? "Semana siguiente" : "Día siguiente"}
              onClick={onNext}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Button>
          </div>
          <h3
            data-testid="cal-title"
            aria-live="polite"
            className="min-w-0 text-sm font-semibold"
          >
            {title}
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-2 sm:ml-auto">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="cal-toggle-cancelled"
                checked={showCancelled}
                onChange={(e) => onShowCancelled(e.target.checked)}
              />
              Mostrar canceladas
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="cal-toggle-tests"
                checked={showTests}
                onChange={(e) => onShowTests(e.target.checked)}
              />
              Mostrar pruebas
            </label>
          </div>
        </>
      )}
    </div>
  );
}
