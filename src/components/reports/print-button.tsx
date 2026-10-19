"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseRangeParams } from "./range-params";
import { reportTabLabel, useReportPrintContext } from "./report-print";

/**
 * 021 — «Descargar PDF»: la impresión del navegador. Mientras dura el diálogo
 * el título del documento es `Reporte <pestaña> <desde>–<hasta>`, que es el
 * nombre de archivo que propone «Guardar como PDF»; al cerrar se restaura.
 */
export function PrintButton() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const meta = useReportPrintContext();

  function print() {
    const tab = reportTabLabel(pathname);
    let range: string;
    if (meta) {
      range = meta.from === meta.to ? meta.from : `${meta.from}–${meta.to}`;
    } else {
      // Sin respuesta del servidor (cargando o con error): el preset de la URL.
      const sel = parseRangeParams(searchParams);
      range = sel.preset === "custom" ? `${sel.from}–${sel.to}` : sel.preset;
    }
    const previous = document.title;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.title = previous;
      window.removeEventListener("afterprint", restore);
    };
    document.title = `Reporte ${tab} ${range}`;
    window.addEventListener("afterprint", restore);
    window.print();
    // `print()` bloquea hasta cerrar el diálogo en casi todos los navegadores;
    // donde no dispara `afterprint`, esto deja el título como estaba.
    window.setTimeout(restore, 1000);
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={print}
      // Sin respuesta del servidor el PDF saldría con los esqueletos de carga.
      disabled={!meta}
      title={meta ? undefined : "Espera a que cargue el reporte"}
      className="shrink-0 print:hidden"
      data-testid="report-print"
    >
      <FileDown className="h-4 w-4" aria-hidden="true" />
      Descargar PDF
    </Button>
  );
}
