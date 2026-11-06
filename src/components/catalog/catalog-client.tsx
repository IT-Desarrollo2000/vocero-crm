"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { FolderTree, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogDto, CatalogProductDto } from "@/lib/catalog";
import {
  catalogSummary,
  filesSummary,
  pausedExplanation,
  productReadiness,
  type CatalogSummary,
  type ProductReadiness,
  type ReadinessTone,
  type ShortcutRef,
} from "@/lib/catalog-readiness";
import type { QuickReplyDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CatalogThumb } from "./catalog-thumb";
import { CategoriesDialog } from "./categories-dialog";
import { ProductDialog } from "./product-dialog";
import { ProductDetail } from "./product-detail";
import { ShortcutRow } from "./shortcut-row";
import { coverImage, filterProducts, responseError, type CategoryFilter } from "./catalog-view";

type Dialog = { kind: "product"; product: CatalogProductDto | null } | { kind: "categories" };

/** Etiqueta de estado de un producto (Listo / Le falta / Pausado). */
export const READINESS_BADGE: Record<ReadinessTone, "success" | "warning" | "destructive" | "secondary"> = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  muted: "secondary",
};

/**
 * 019 — Página Catálogo (spec 019, escenarios 1 y 6). Todo el equipo la ve;
 * `canEdit` (Propietario) enciende la gestión. La autorización real está en
 * la API: un Vendedor que fuerce una escritura recibe 403.
 *
 * 032 — Se explica sola: al Vendedor le dice cómo mandar un producto desde la
 * Bandeja (botón «Catálogo» o el atajo, con «Copiar»); al Propietario, qué
 * le falta a cada producto para mandarse (`src/lib/catalog-readiness.ts`).
 * Los atajos salen de `/api/quick-replies`; si esa lectura falla, el catálogo
 * se muestra igual y solo se calla lo que dependa de los atajos.
 *
 * El proveedor de almacenamiento (`CatalogDto.storage`) no se muestra aquí:
 * es de Ajustes, y con el conector apagado la UI no debe nombrarlo (FR-913).
 */
export function CatalogClient({ canEdit }: { canEdit: boolean }) {
  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutRef[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const refetchShortcuts = useCallback(async () => {
    const res = await fetch("/api/quick-replies", { cache: "no-store" }).catch(() => null);
    const data = res?.ok
      ? ((await res.json().catch(() => null)) as { quickReplies?: QuickReplyDto[] } | null)
      : null;
    if (!data || !Array.isArray(data.quickReplies)) {
      // Se queda lo último que se leyó (null la primera vez): sin atajos
      // legibles no se acusa ningún faltante de atajos.
      return;
    }
    setShortcuts(
      data.quickReplies.map((q) => ({
        shortcut: q.shortcut,
        productId: q.productId,
        attach: q.attach,
      }))
    );
  }, []);

  const refetchCatalog = useCallback(async () => {
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

  const refetch = useCallback(async () => {
    await Promise.all([refetchCatalog(), refetchShortcuts()]);
  }, [refetchCatalog, refetchShortcuts]);

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
  const readiness = useMemo(
    () => new Map(products.map((p) => [p.id, productReadiness(p, shortcuts)])),
    [products, shortcuts]
  );
  const summary = useMemo(
    () =>
      catalogSummary(
        products.flatMap((p) => {
          const r = readiness.get(p.id);
          return r ? [{ product: p, readiness: r }] : [];
        })
      ),
    [products, readiness]
  );
  const visible = useMemo(
    () => filterProducts(products, query, category),
    [products, query, category]
  );
  const uncategorized = products.filter((p) => p.categoryId === null).length;
  const selected = products.find((p) => p.id === selectedId) ?? null;
  const selectedReadiness = selected ? readiness.get(selected.id) : undefined;
  const categoryName = (id: string | null) =>
    id ? categories.find((c) => c.id === id)?.name : undefined;
  const countIn = (id: string) => products.filter((p) => p.categoryId === id).length;

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
        {(categories.length > 0 || uncategorized > 0) && products.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categorías">
            <Chip active={category === "all"} onClick={() => setCategory("all")}>
              Todas · {products.length}
            </Chip>
            {categories.map((c) => (
              <Chip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
                {c.name} · {countIn(c.id)}
              </Chip>
            ))}
            {categories.length > 0 && uncategorized > 0 && (
              <Chip active={category === "none"} onClick={() => setCategory("none")}>
                Sin categoría · {uncategorized}
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
            <p className="text-sm font-medium">
              {canEdit ? "El catálogo está vacío" : "Todavía no hay productos"}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {canEdit
                ? "Crea el primero con «Nuevo producto»: nombre, precio, variantes, fotos y fichas que el equipo comparte desde la Bandeja."
                : "Pídele al propietario que cargue el catálogo. Cuando lo haga, aquí verás cada producto con su atajo para mandarlo desde la Bandeja."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {loadError && (
              // Ya había catálogo: el fallo de una relectura no lo borra.
              <p className="text-sm text-danger-text" role="alert">
                {loadError}{" "}
                <button className="underline" onClick={() => void refetch()}>
                  Reintentar
                </button>
              </p>
            )}
            {canEdit ? <OwnerSummary summary={summary} /> : <HowToSend />}
            {visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
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
                <ul
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                  aria-label="Productos"
                >
                  {visible.map((p) => {
                    const r = readiness.get(p.id);
                    if (!r) return null;
                    return (
                      <li key={p.id} className="min-w-0">
                        <ProductCard
                          product={p}
                          readiness={r}
                          canEdit={canEdit}
                          categoryName={categoryName(p.categoryId)}
                          selected={p.id === selectedId}
                          onOpen={() => setSelectedId(p.id)}
                        />
                      </li>
                    );
                  })}
                </ul>
                <p className="text-center text-xs text-muted-foreground">
                  Mostrando {visible.length} de {products.length}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {selected && selectedReadiness && catalog && (
        <ProductDetail
          product={selected}
          readiness={selectedReadiness}
          shortcuts={shortcuts}
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

/** 032 — Vendedor: cómo se manda un producto desde la Bandeja. */
function HowToSend() {
  return (
    <section
      aria-label="Cómo mandar un producto"
      data-testid="catalog-how-to-send"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-info-soft bg-info-tint px-4 py-3"
    >
      <strong className="text-sm font-semibold text-foreground">
        Para mandarle un producto a un cliente:
      </strong>
      <ol className="contents">
        <Step n={1}>Abre su chat en la Bandeja</Step>
        <Step n={2}>Toca «Catálogo», o escribe el atajo del producto (abajo)</Step>
      </ol>
      <span className="text-[13px] text-text-2">
        Aquí solo se consulta; los productos los carga el propietario.
      </span>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-[13.5px] text-foreground">
      <span
        aria-hidden
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-background text-xs font-bold text-info-text"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** 032 — Propietario: cuántos están listos y qué les falta a los demás. */
function OwnerSummary({ summary }: { summary: CatalogSummary }) {
  if (summary.active === 0 && summary.paused === 0) return null;
  const pausedNote =
    summary.paused > 0
      ? summary.paused === 1
        ? "1 producto está pausado y no se manda."
        : `${summary.paused} productos están pausados y no se mandan.`
      : null;
  if (!summary.headline) {
    return (
      <section
        aria-label="Lo que le falta a tu catálogo"
        data-testid="catalog-summary"
        data-state="ready"
        className="space-y-1 rounded-lg border border-success-soft bg-success-tint px-4 py-3"
      >
        <strong className="block text-sm font-semibold text-foreground">
          {summary.active === 0
            ? "No hay productos activos"
            : summary.ready === summary.active
              ? summary.active === 1
                ? "Tu producto está listo para mandar"
                : `Los ${summary.active} productos activos están listos para mandar`
              : `${summary.ready} de ${summary.active} productos activos están listos para mandar`}
        </strong>
        {[summary.fichaNote, pausedNote].filter(Boolean).map((t) => (
          <span key={t} className="block text-[13px] text-text-2">
            {t}
          </span>
        ))}
      </section>
    );
  }
  return (
    <section
      aria-label="Lo que le falta a tu catálogo"
      data-testid="catalog-summary"
      data-state="missing"
      className="space-y-1.5 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3"
    >
      <strong className="block text-sm font-semibold text-foreground">{summary.headline}</strong>
      <span className="block text-[13px] text-text-2">
        {summary.details.join(" · ")}
        {summary.more > 0 ? ` · y ${summary.more} más` : ""}.
      </span>
      {[
        summary.ready > 0
          ? `${summary.ready} de ${summary.active} ${summary.active === 1 ? "producto activo está listo" : "productos activos están listos"} para mandar.`
          : null,
        summary.fichaNote,
        pausedNote,
      ]
        .filter(Boolean)
        .map((t) => (
          <span key={t} className="block text-[13px] text-text-2">
            {t}
          </span>
        ))}
    </section>
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
  readiness,
  canEdit,
  categoryName,
  selected,
  onOpen,
}: {
  product: CatalogProductDto;
  readiness: ProductReadiness;
  canEdit: boolean;
  categoryName: string | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
  const statusId = useId();
  const cover = coverImage(product);
  const files = filesSummary(readiness.images, readiness.documents);
  const paused = readiness.state === "paused";
  const variants =
    product.variants.length > 0
      ? `${product.variants.length} ${product.variants.length === 1 ? "variante" : "variantes"}`
      : null;
  // Vendedor: lo que ayuda a mandarlo. Propietario: precio, código y estado.
  const meta = canEdit
    ? [product.price ?? "Sin precio", product.code ?? "sin código"]
    : [categoryName, product.price, files];
  const sublines = canEdit ? [categoryName, variants, files].filter(Boolean) : [variants];
  const linked = readiness.shortcuts ?? [];
  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-colors",
        selected && "border-brand",
        paused && "bg-secondary"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="catalog-product"
        data-product-id={product.id}
        data-active={product.active ? "true" : "false"}
        data-readiness={readiness.state}
        aria-label={`Abrir ${product.name}`}
        aria-describedby={canEdit || paused ? statusId : undefined}
        className="flex w-full min-w-0 flex-col text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className={cn("relative block w-full", paused && "opacity-60")}>
          <CatalogThumb src={cover?.url} alt={product.name} className="aspect-[4/3] w-full" />
          {!cover && canEdit && (
            <span className="absolute inset-x-0 bottom-3 text-center text-xs text-text-2">
              Sin fotos todavía
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1 p-3">
          <span className={cn("break-words text-sm font-medium", paused && "text-text-2")}>
            {product.name}
          </span>
          <span className="break-words text-xs text-text-2">
            {meta.filter(Boolean).join(" · ") || "Sin precio"}
          </span>
          {sublines.some(Boolean) && (
            <span className="break-words text-[11px] text-text-3">
              {sublines.filter(Boolean).join(" · ")}
            </span>
          )}
          {(canEdit || paused) && (
            <span id={statusId} data-testid="catalog-readiness" data-state={readiness.state}>
              <Badge
                variant={READINESS_BADGE[readiness.tone]}
                className="max-w-full whitespace-normal text-[11px]"
              >
                {readiness.label}
              </Badge>
            </span>
          )}
        </span>
      </button>

      {!canEdit && (
        <div className="flex min-w-0 flex-col gap-1.5 px-3 pb-3">
          {paused ? (
            <p className="text-xs text-text-2">{pausedExplanation(false)}</p>
          ) : linked.length > 0 ? (
            <>
              <p className="text-xs text-text-2">Escríbelo en el chat para mandarlo:</p>
              {linked.map((s) => (
                <ShortcutRow key={s.shortcut} shortcut={s.shortcut} sends={s.sends} />
              ))}
            </>
          ) : readiness.shortcuts !== null ? (
            <p className="text-xs text-text-2">
              Sin atajo todavía: mándalo desde «Catálogo» en el chat.
            </p>
          ) : (
            <p className="text-xs text-text-2">
              No se pudieron leer sus atajos; desde «Catálogo» en el chat se manda igual.
            </p>
          )}
          {!paused && readiness.images === 0 && (
            <p className="text-xs text-text-2">
              Sin fotos todavía: pídele al propietario que las suba.
            </p>
          )}
          {!paused && readiness.images > 0 && readiness.documents === 0 && (
            <p className="text-xs text-text-2">
              Sin ficha PDF. Desde «Catálogo» en el chat puedes mandar solo las fotos.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
