"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Pestañas de Reportes, en este orden: «Resumen» (021, para dirección),
 * «Agente» (02), «Citas» (10, solo con `AGENDA` encendida), «Ventas» (021),
 * «Vendedores» (024) y «Anuncios» (020). Al cambiar de pestaña se conserva el rango de la URL.
 */
export function ReportsTabs({ bookings }: { bookings: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();
  const withRange = (href: string) => (qs ? `${href}?${qs}` : href);
  const tab = (href: string, label: string) => (
    <Tab key={href} href={withRange(href)} label={label} active={pathname.startsWith(href)} />
  );
  return (
    <nav aria-label="Tipos de reporte" className="-mb-px mt-3 flex gap-1 overflow-x-auto">
      {tab("/reports/summary", "Resumen")}
      {tab("/reports/agent", "Agente")}
      {bookings && tab("/reports/bookings", "Citas")}
      {tab("/reports/sales", "Ventas")}
      {tab("/reports/sellers", "Vendedores")}
      {tab("/reports/ads", "Anuncios")}
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
