"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, FolderTree, Image as ImageIcon, Layers, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogDto, CatalogProductDto } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { CatalogThumb } from "./catalog-thumb";
import { CategoriesDialog } from "./categories-dialog";
import { ProductDialog } from "./product-dialog";
import { ProductDetail } from "./product-detail";
import { coverImage, filterProducts, responseError, type CategoryFilter } from "./catalog-view";

type Dialog = { kind: "product"; product: CatalogProductDto | null } | { kind: "categories" };

/**
 * 019 — Página Catálogo (spec 019, escenarios 1 y 6). Todo el equipo la ve;
 * `canEdit` (Propietario) enciende la gestión. La autorización real está en
 * la API: un Vendedor que fuerce una escritura recibe 403.
 *
 * El proveedor de almacenamiento (`CatalogDto.storage`) no se muestra aquí:
 * es de Ajustes, y con el conector apagado la UI no debe nombrarlo (FR-913).
 */
export function CatalogClient({ canEdit }: { canEdit: boolean }) {
  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/catalog", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setLoadError(await responseError(res, "No se pudo cargar el catálogo"));
      setLoading(false);
      return;
    }
    const data = (await res.json().catch(() => null)) as CatalogDto | null;
    if (!data || !Array.isArray(data.products) || !Array.isArray(data.categories)) {
      setLoadError("El servidor respondió algo inesperado");
      setLoading(false);
      return;
    }
    setCatalog(data);
    setLoadError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const categories = useMemo(
    () => [...(catalog?.categories ?? [])].sort((a, b) => a.position - b.position),
    [catalog]
  );
  const products = useMemo(
    () => [...(catalog?.products ?? [])].sort((a, b) => a.position - b.position),
    [catalog]
  );
  const visible = useMemo(
    () => filterProducts(products, query, category),
    [products, query, category]
  );
  const uncategorized = products.some((p) => p.categoryId === null);
  const selected = products.find((p) => p.id === selectedId) ?? null;
  const categoryName = (id: string | null) =>
    id ? categories.find((c) => c.id === id)?.name : undefined;

  // Una categoría borrada no puede quedar como filtro activo.
  useEffect(() => {
    if (category !== "all" && category !== "none" && !categories.some((c) => c.id === category)) {
      setCategory("all");
    }
  }, [categories, category]);

  const closeDetail = useCallback(() => setSelectedId(null), []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="space-y-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Catálogo</h2>
            {canEdit && (
              <>
                <Button size="sm" onClick={() => setDialog({ kind: "product", product: null })}>
                  <Plus className="h-4 w-4" strokeWidth={1.8} />
                  Nuevo producto
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "categories" })}>
                  <FolderTree className="h-4 w-4" strokeWidth={1.8} />
                  Categorías
                </Button>
              </>
            )}
          </div>
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Buscar por nombre o código…"
              aria-label="Buscar producto"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 sm:w-72"
            />
          </div>
        </div>
        {(categories.length > 0 || uncategorized) && products.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por categoría">
            <Chip active={category === "all"} onClick={() => setCategory("all")}>
              Todas
            </Chip>
            {categories.map((c) => (
              <Chip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
                {c.name}
              </Chip>
            ))}
            {categories.length > 0 && uncategorized && (
              <Chip active={category === "none"} onClick={() => setCategory("none")}>
                Sin categoría
              </Chip>
            )}
          </div>
        )}
      </header>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        {loading && !catalog ? (
          <p className="text-sm text-text-3" role="status">
            Cargando catálogo…
          </p>
        ) : loadError && !catalog ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-danger-text" role="alert">
              {loadError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                void refetch();
              }}
            >
              Reintentar
            </Button>
          </div>
        ) : products.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">El catálogo está vacío</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {canEdit
                ? "Crea el primero con «Nuevo producto»: nombre, precio, variantes, fotos y fichas que el equipo comparte desde la Bandeja."
                : "Cuando el Propietario cargue productos los verás aquí con sus fotos y fichas."}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">Sin resultados</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Ningún producto coincide
              {query.trim() ? ` con «${query.trim()}»` : ""}
              {category === "none"
                ? " sin categoría"
                : category !== "all"
                  ? ` en «${categoryName(category) ?? ""}»`
                  : ""}
              .
            </p>
          </div>
        ) : (
          <>
            {loadError && (
              // Ya había catálogo: el fallo de una relectura no lo borra.
              <p className="mb-3 text-sm text-danger-text" role="alert">
                {loadError}{" "}
                <button className="underline" onClick={() => void refetch()}>
                  Reintentar
                </button>
              </p>
            )}
            <ul
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
              aria-label="Productos"
            >
              {visible.map((p) => (
                <li key={p.id} className="min-w-0">
                  <ProductCard
                    product={p}
                    categoryName={categoryName(p.categoryId)}
                    selected={p.id === selectedId}
                    onOpen={() => setSelectedId(p.id)}
                  />
                </li>
              ))}
            </ul>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Mostrando {visible.length} de {products.length}
            </p>
          </>
        )}
      </div>

      {selected && catalog && (
        <ProductDetail
          product={selected}
          categories={categories}
          canEdit={canEdit}
          paused={dialog !== null}
          onClose={closeDetail}
          onEdit={() => setDialog({ kind: "product", product: selected })}
          onChanged={refetch}
          onDeleted={() => {
            setSelectedId(null);
            void refetch();
          }}
        />
      )}

      {canEdit && dialog?.kind === "product" && (
        <ProductDialog
          product={dialog.product}
          categories={categories}
          defaultCategoryId={
            category !== "all" && category !== "none" ? category : null
          }
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            setDialog(null);
            setSelectedId(p.id);
            void refetch();
          }}
        />
      )}
      {canEdit && dialog?.kind === "categories" && (
        <CategoriesDialog
          categories={categories}
          onClose={() => setDialog(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "max-w-full truncate rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-brand-soft bg-brand-tint text-brand-text"
          : "bg-secondary text-text-2 hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function ProductCard({
  product,
  categoryName,
  selected,
  onOpen,
}: {
  product: CatalogProductDto;
  categoryName: string | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
  const cover = coverImage(product);
  const images = product.files.filter((f) => f.kind === "image").length;
  const docs = product.files.length - images;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="catalog-product"
      data-product-id={product.id}
      data-active={product.active ? "true" : "false"}
      aria-label={`Abrir ${product.name}`}
      className={cn(
        "flex w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-colors hover:border-brand-soft",
        selected && "border-brand",
        !product.active && "opacity-60"
      )}
    >
      <CatalogThumb src={cover?.url} alt={product.name} className="aspect-[4/3] w-full" />
      <div className="min-w-0 space-y-1 p-3">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{product.name}</span>
          {!product.active && <Badge variant="warning">Inactivo</Badge>}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-text-3">
          {product.code && <code className="text-brand-text">{product.code}</code>}
          {categoryName && <span className="truncate">{categoryName}</span>}
        </p>
        <p className="truncate text-sm">{product.price ?? <span className="text-text-3">Sin precio</span>}</p>
        <p className="flex flex-wrap items-center gap-3 text-[11px] text-text-3">
          <span className="inline-flex items-center gap-1" title="Variantes">
            <Layers className="h-3.5 w-3.5" aria-hidden />
            {product.variants.length} {product.variants.length === 1 ? "variante" : "variantes"}
          </span>
          <span className="inline-flex items-center gap-1" title="Imágenes">
            <ImageIcon className="h-3.5 w-3.5" aria-hidden />
            {images}
          </span>
          <span className="inline-flex items-center gap-1" title="Documentos">
            <FileText className="h-3.5 w-3.5" aria-hidden />
            {docs}
          </span>
        </p>
      </div>
    </button>
  );
}
