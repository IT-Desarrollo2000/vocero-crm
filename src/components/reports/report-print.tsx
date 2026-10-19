"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname } from "next/navigation";
import { useViewer } from "@/components/viewer-context";
import { formatDayRange } from "./format";

/**
 * 021 — Descargar PDF de Reportes. El PDF es la impresión del navegador
 * (`window.print()` → «Guardar como PDF», D3): sin dependencias ni cambios en
 * la imagen. El rango RESUELTO (días y zona) solo lo conoce la respuesta del
 * servidor, que vive en el cliente de cada pestaña; este contexto lo sube al
 * layout para que el botón (título = nombre del archivo) y el encabezado de
 * impresión digan lo mismo que el selector.
 */
export type ReportPrintMeta = { from: string; to: string; tz: string };

type Ctx = {
  meta: ReportPrintMeta | null;
  setMeta: (meta: ReportPrintMeta | null) => void;
};

const ReportPrintContext = createContext<Ctx | null>(null);

export function ReportPrintProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<ReportPrintMeta | null>(null);
  return (
    <ReportPrintContext.Provider value={{ meta, setMeta }}>
      {children}
    </ReportPrintContext.Provider>
  );
}

/** Lo llama cada pestaña con el rango que devolvió el servidor (null = sin datos). */
export function useReportPrintMeta(range: ReportPrintMeta | null | undefined) {
  const setMeta = useContext(ReportPrintContext)?.setMeta;
  const from = range?.from;
  const to = range?.to;
  const tz = range?.tz;
  useEffect(() => {
    if (!setMeta) return;
    setMeta(from && to && tz ? { from, to, tz } : null);
    // Al cambiar de pestaña el rango de la anterior no debe colarse al PDF.
    return () => setMeta(null);
  }, [setMeta, from, to, tz]);
}

export function useReportPrintContext(): ReportPrintMeta | null {
  return useContext(ReportPrintContext)?.meta ?? null;
}

const TAB_LABEL: Record<string, string> = {
  agent: "Agente",
  bookings: "Citas",
  sales: "Ventas",
  summary: "Resumen",
  ads: "Anuncios",
};

/** Pestaña activa a partir de `/reports/<pestaña>`. */
export function reportTabLabel(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean)[1] ?? "";
  return TAB_LABEL[seg] ?? "General";
}

/** «Generado el 19 oct 2026 a las 14:05», en la zona del negocio si se conoce. */
function formatGeneratedAt(date: Date, timeZone?: string): string {
  const fmt = (tz?: string) => {
    const day = date.toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: tz,
    });
    const time = date.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });
    return `Generado el ${day.replace(".", "")} a las ${time}`;
  };
  try {
    return fmt(timeZone);
  } catch {
    return fmt();
  }
}

/**
 * Encabezado que solo existe en papel: negocio, pestaña, rango y zona (como
 * los muestra el selector) y la hora de impresión. La hora se calcula en el
 * cliente (nada de `new Date()` en el render del servidor) y se refresca en
 * `beforeprint`, que también dispara Ctrl+P.
 */
export function ReportPrintHeader() {
  const { businessName } = useViewer();
  const pathname = usePathname();
  const meta = useReportPrintContext();
  const [printedAt, setPrintedAt] = useState<Date | null>(null);

  useEffect(() => {
    setPrintedAt(new Date());
    // Chrome toma la foto de impresión en la misma tarea que `beforeprint`:
    // sin flushSync el render llegaría tarde y saldría la hora de carga.
    const onBefore = () => flushSync(() => setPrintedAt(new Date()));
    window.addEventListener("beforeprint", onBefore);
    return () => window.removeEventListener("beforeprint", onBefore);
  }, []);

  return (
    <div className="hidden border-b pb-3 print:mb-4 print:block" data-testid="report-print-header">
      <p className="text-xs font-medium text-muted-foreground">{businessName}</p>
      <h1 className="text-lg font-semibold">Reporte · {reportTabLabel(pathname)}</h1>
      <p className="text-sm text-text-2">
        {meta ? `${formatDayRange(meta.from, meta.to)} · ${meta.tz}` : "Rango del reporte"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {printedAt ? `${formatGeneratedAt(printedAt, meta?.tz)} · ` : ""}
        Solo Propietario · no incluye el Laboratorio
      </p>
    </div>
  );
}
