import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 036 fase 2 — Piezas de la pantalla «Importar contactos desde Excel»
 * (diseño aprobado: specs/036-importar-leads-evento/diseno/*.dc.html).
 */

export type ImportStep = 1 | 2 | 3;

const STEPS: { n: ImportStep; label: string }[] = [
  { n: 1, label: "Subir la lista" },
  { n: 2, label: "Revisar" },
  { n: 3, label: "Listo" },
];

/** Encabezado común: ruta, título y (opcional) bajada. */
export function ImportHeader({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <nav aria-label="Ruta" className="text-[13px] text-text-2">
        <Link href="/contacts" className="text-brand-text underline-offset-2 hover:underline">
          Contactos
        </Link>{" "}
        › Importar desde Excel
      </nav>
      <h1 className="flex items-center gap-2.5 text-2xl font-bold">
        {icon}
        {title}
      </h1>
      {children}
    </header>
  );
}

/** Pasos 1-2-3: hecho (✓), actual (círculo de acento) o pendiente. */
export function Stepper({ current }: { current: ImportStep }) {
  return (
    <ol aria-label="Pasos" className="flex flex-wrap gap-2 text-[13px]">
      {STEPS.map(({ n, label }) => {
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li
            key={n}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5",
              state === "current"
                ? "bg-brand-tint font-semibold text-brand-text"
                : "border border-border text-text-2"
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full text-xs",
                state === "current" && "bg-brand text-brand-fg",
                state === "done" && "bg-brand-tint text-brand-text",
                state === "todo" && "border border-border-strong"
              )}
            >
              {state === "done" ? <Check className="h-3 w-3" strokeWidth={2.5} aria-label="hecho" /> : n}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** Tarjeta (sección) con borde, como en el diseño. */
export function Card({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"section">) {
  return (
    <section className={cn("flex flex-col rounded-lg border border-border px-5 py-4", className)} {...props}>
      {children}
    </section>
  );
}

export type Tone = "success" | "danger" | "warning" | "neutral";

const TONE: Record<Tone, string> = {
  success: "border-success-soft bg-success-tint text-success-text",
  danger: "border-danger-soft bg-danger-tint text-danger-text",
  warning: "border-warning-soft bg-warning-tint text-warning-text",
  neutral: "border-border text-text-2",
};

/** Número grande + etiqueta + una frase (paso Revisar). */
export function StatCard({
  tone,
  value,
  label,
  note,
  testId,
}: {
  tone: Tone;
  value: number;
  label: string;
  note: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-md border px-3.5 py-3", TONE[tone])} data-testid={testId}>
      <span className={cn("text-2xl font-bold", tone === "neutral" && "text-foreground")} data-testid={testId ? `${testId}-n` : undefined}>
        {value.toLocaleString("es-MX")}
      </span>
      <span className="text-[13px] font-semibold">{label}</span>
      <span className="text-[12.5px]">{note}</span>
    </div>
  );
}
