"use client";

import { useEffect } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CATALOG_LIMITS } from "@/lib/catalog";
import type { AttributeRow } from "./catalog-view";

/**
 * Modal del catálogo (mismo patrón que `NewContactDialog`): velo que cierra,
 * `role="dialog"` con nombre accesible —el E2E acota sus campos por él— y
 * Escape para salir. En el teléfono ocupa la pantalla.
 */
export function CatalogDialog({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-center bg-overlay sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={
          "flex w-full flex-col overflow-y-auto border bg-card p-5 shadow-xl sm:max-h-[90vh] sm:rounded-lg " +
          (wide ? "sm:max-w-2xl" : "sm:max-w-lg")
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start gap-2">
          <h3 className="flex-1 font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1 -mt-1 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {description && <p className="mb-4 text-xs text-text-3">{description}</p>}
        {!description && <div className="mb-3" />}
        {children}
      </div>
    </div>
  );
}

/** Lista editable de pares `Etiqueta: valor` (atributos de producto o variante). */
export function AttributesEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: AttributeRow[];
  onChange: (rows: AttributeRow[]) => void;
  disabled?: boolean;
}) {
  function set(i: number, patch: Partial<AttributeRow>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">Atributos</legend>
      {rows.length === 0 && (
        <p className="text-xs text-text-3">Sin atributos (p. ej. «Motor: eléctrico»).</p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`Atributo ${i + 1}: etiqueta`}
            placeholder="Etiqueta"
            value={r.label}
            maxLength={CATALOG_LIMITS.attributeLabelMax}
            onChange={(e) => set(i, { label: e.target.value })}
            className="w-2/5 min-w-0"
          />
          <Input
            aria-label={`Atributo ${i + 1}: valor`}
            placeholder="Valor"
            value={r.value}
            maxLength={CATALOG_LIMITS.attributeValueMax}
            onChange={(e) => set(i, { value: e.target.value })}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Quitar atributo ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {rows.length < CATALOG_LIMITS.attributesMax && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { label: "", value: "" }])}
        >
          <Plus className="h-4 w-4" />
          Agregar atributo
        </Button>
      )}
    </fieldset>
  );
}

/** Campo con `<label>` asociado (los nombres son los que usa el E2E). */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-text-3">{hint}</p>}
    </div>
  );
}
