"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Package, RotateCw, Search, X } from "lucide-react";
import {
  fileCompatibility,
  productDetailsText,
  type CatalogDto,
  type CatalogFileDto,
  type CatalogProductDto,
} from "@/lib/catalog";
import type { OutboundFiles } from "@/lib/outbound-files";
import { cn } from "@/lib/utils";
import { formatBytes } from "./helpers";
import { filterCatalogProducts, panelFiles, productCover } from "./catalog-staging";

/**
 * 019 — Panel del botón Catálogo (FR-931): búsqueda + categorías → producto
 * activo → variante opcional → casillas de archivos. "Agregar" escenifica las
 * marcadas como chips (y cierra); "Insertar detalles" pone el texto del
 * producto en el campo (y deja el panel abierto para marcar archivos).
 * En móvil ocupa la pantalla completa.
 */
export function CatalogPanel({
  catalog,
  loading,
  error,
  onRetry,
  outboundFiles,
  isOwner,
  onAdd,
  onInsertDetails,
  onClose,
}: {
  catalog: CatalogDto | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  outboundFiles: OutboundFiles | null;
  isOwner: boolean;
  onAdd: (files: CatalogFileDto[]) => void;
  onInsertDetails: (text: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [inserted, setInserted] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const products = useMemo(
    () => filterCatalogProducts(catalog?.products ?? [], query, categoryId),
    [catalog, query, categoryId]
  );
  const anyActive = (catalog?.products ?? []).some((p) => p.active);
  const product: CatalogProductDto | null =
    catalog?.products.find((p) => p.id === productId && p.active) ?? null;
  const variants = product?.variants.filter((v) => v.active) ?? [];
  const variant = variants.find((v) => v.id === variantId) ?? null;
  const files = product ? panelFiles(product, variant?.id ?? null) : [];

  function choose(p: CatalogProductDto) {
    setProductId(p.id);
    setVariantId(null);
    setChecked(new Set());
    setInserted(false);
  }

  function chooseVariant(id: string | null) {
    setVariantId(id);
    setInserted(false);
    // Solo siguen marcadas las que existen con la variante nueva.
    if (!product) return;
    const visible = new Set(panelFiles(product, id).map((f) => f.id));
    setChecked((prev) => new Set([...prev].filter((x) => visible.has(x))));
  }

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-overlay md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Catálogo"
        className="flex h-full w-full flex-col bg-card shadow-xl md:h-auto md:max-h-[80vh] md:max-w-lg md:rounded-lg md:border"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          {product && (
            <button
              onClick={() => setProductId(null)}
              aria-label="Volver a los productos"
              className="rounded p-1 text-text-3 hover:bg-secondary hover:text-text-1"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
            </button>
          )}
          <h3 className="min-w-0 flex-1 truncate font-semibold">
            {product ? product.name : "Catálogo"}
          </h3>
          <button
            onClick={onClose}
            aria-label="Cerrar catálogo"
            className="rounded p-1 text-text-3 hover:bg-secondary hover:text-text-1"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && !catalog && (
            <div className="space-y-2 text-sm">
              <p className="text-danger-text" role="alert">
                {error}
              </p>
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary"
              >
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.7} />
                Reintentar
              </button>
            </div>
          )}
          {loading && !catalog && <p className="text-sm text-text-3">Cargando catálogo…</p>}

          {catalog && !anyActive && (
            <div className="space-y-2 py-4 text-center text-sm text-text-3">
              <Package className="mx-auto h-8 w-8" strokeWidth={1.5} />
              <p>El catálogo está vacío.</p>
              {isOwner && (
                <Link href="/catalog" className="font-medium text-brand-text hover:underline">
                  Ir a Catálogo para agregar productos
                </Link>
              )}
            </div>
          )}

          {catalog && anyActive && !product && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 focus-within:border-brand">
                <Search className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Nombre o código"
                  aria-label="Buscar en el catálogo"
                  className="w-full bg-transparent py-1.5 text-sm outline-none"
                />
              </div>
              {catalog.categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categorías">
                  {[{ id: null, name: "Todas" }, ...catalog.categories].map((c) => (
                    <button
                      key={c.id ?? "all"}
                      aria-pressed={categoryId === c.id}
                      onClick={() => setCategoryId(c.id)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        categoryId === c.id
                          ? "border-brand-soft bg-brand-tint text-brand-text"
                          : "bg-secondary text-text-2 hover:bg-brand-tint"
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {products.length === 0 ? (
                <p className="text-sm text-text-3">Ningún producto coincide.</p>
              ) : (
                <ul className="space-y-1" aria-label="Productos">
                  {products.map((p) => {
                    const cover = productCover(p);
                    return (
                      <li key={p.id}>
                        <button
                          onClick={() => choose(p)}
                          className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-subtle focus-visible:bg-subtle"
                        >
                          {cover ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={cover.url}
                              alt=""
                              loading="lazy"
                              className="h-10 w-10 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-secondary">
                              <Package className="h-5 w-5 text-text-3" strokeWidth={1.5} />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-text-3">
                              {[p.code, p.price].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {product && (
            <div className="space-y-3">
              {variants.length > 0 && (
                <label className="block text-xs text-text-2">
                  Variante
                  <select
                    value={variantId ?? ""}
                    onChange={(e) => chooseVariant(e.target.value || null)}
                    className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
                  >
                    <option value="">Todas / compartidos</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {files.length === 0 ? (
                <p className="text-sm text-text-3">Este producto no tiene archivos.</p>
              ) : (
                <ul className="space-y-1" aria-label="Archivos">
                  {files.map((f) => {
                    const c = fileCompatibility(f, outboundFiles);
                    return (
                      <li key={f.id}>
                        <label
                          title={c.ok ? f.fileName : c.reason}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md px-2 py-1.5",
                            c.ok ? "cursor-pointer hover:bg-subtle" : "opacity-50"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(f.id)}
                            disabled={!c.ok}
                            onChange={() => toggle(f.id)}
                            aria-label={f.fileName}
                          />
                          {f.kind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={f.url}
                              alt=""
                              loading="lazy"
                              className="h-9 w-9 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <FileText className="h-6 w-6 shrink-0 text-brand" strokeWidth={1.5} />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{f.fileName}</span>
                            <span className="block truncate text-[11px] text-text-3">
                              {c.ok ? formatBytes(f.size) : c.reason}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {product && (
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
            <button
              onClick={() => {
                onInsertDetails(productDetailsText(product, variant));
                setInserted(true);
              }}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-secondary"
            >
              Insertar detalles
            </button>
            {inserted && <span className="text-xs text-text-3">Detalles en el campo</span>}
            <span className="flex-1" />
            <button
              disabled={checked.size === 0}
              onClick={() => onAdd(files.filter((f) => checked.has(f.id)))}
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:bg-brand-hover disabled:opacity-40"
            >
              Agregar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
