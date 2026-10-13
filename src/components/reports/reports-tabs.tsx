"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Pestañas de Reportes. «Agente» (02) y «Citas» (10, solo con `AGENDA`
 * encendida); «Ventas» (punto 1) y «Anuncios» (07, solo con `ATRIBUCION`
 * encendida) se anuncian deshabilitadas para que el marco no cambie de forma
 * cuando lleguen. Al cambiar de pestaña se conserva el rango de la URL.
 */
export function ReportsTabs({ ads, bookings }: { ads: boolean; bookings: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();
  const withRange = (href: string) => (qs ? `${href}?${qs}` : href);
  return (
    <nav aria-label="Tipos de reporte" className="-mb-px mt-3 flex gap-1 overflow-x-auto">
      <Tab href={withRange("/reports/agent")} label="Agente" active={pathname.startsWith("/reports/agent")} />
      {bookings && (
        <Tab
          href={withRange("/reports/bookings")}
          label="Citas"
          active={pathname.startsWith("/reports/bookings")}
        />
      )}
      <DisabledTab label="Ventas" />
      {ads && <DisabledTab label="Anuncios" />}
    </nav>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "shrink-0 border-b-2 px-3 pb-2 text-sm font-medium",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-text-3 hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
}

function DisabledTab({ label }: { label: string }) {
  return (
    <span
      aria-disabled="true"
      title="Próximamente"
      className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 pb-2 text-sm text-text-4"
    >
      {label}
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-text-3">
        Próximamente
      </span>
    </span>
  );
}
