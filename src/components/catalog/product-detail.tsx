"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileText,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CATALOG_LIMITS,
  SHORTCUT_CODE_MAX,
  defaultShortcutsFor,
  type CatalogCategoryDto,
  type CatalogFileDto,
  type CatalogProductDto,
  type CatalogVariantDto,
} from "@/lib/catalog";
import {
  CONVERTIBLE_IMAGE_ACCEPT,
  normalizationSummary,
  normalizeImageFile,
} from "@/lib/image-normalize";
import { WHATSAPP_OUTBOUND_FILES } from "@/lib/outbound-files";
import { cn } from "@/lib/utils";
import { CatalogThumb } from "./catalog-thumb";
import { VariantDialog } from "./product-dialog";
import {
  formatBytes,
  groupFiles,
  responseError,
  sendJson,
  shortcutOutcome,
  swapPositions,
  variantPrice,
  type FileGroup,
  type ShortcutOutcome,
} from "./catalog-view";

type Upload = {
  key: string;
  name: string;
  status: "pending" | "uploading" | "done" | "error";
  message?: string;
  /** "convertida a JPG (1.2 MB)" / "reducida a 4.7 MB". */
  converted?: string;
  /** Aviso de la conversión (formato no decodificable, primer fotograma…). */
  note?: string;
};

/**
 * Extensiones que admite el catálogo (la API decide por la firma, igual).
 * WebP/GIF/HEIC/HEIF se ofrecen porque el navegador los convierte a JPG
 * antes de subir; el servidor sigue aceptando solo JPG/PNG.
 */
const UPLOAD_ACCEPT = `.jpg,.jpeg,.png,.pdf,.docx,.xlsx,.pptx,.txt,.csv,${CONVERTIBLE_IMAGE_ACCEPT}`;

/**
 * Tope de imagen al subir: el de WhatsApp (5 MB), el más bajo de los tres
 * canales, para que toda foto del catálogo sirva en WhatsApp, Messenger e
 * Instagram.
 */
const UPLOAD_IMAGE_MAX_BYTES =
  WHATSAPP_OUTBOUND_FILES.rules.find((r) => r.kind === "image")?.maxBytes ?? 5 * 1024 * 1024;

/**
 * Detalle de un producto: panel lateral en escritorio, pantalla completa en
 * el teléfono. El Vendedor lo ve en solo lectura; el Propietario además edita
 * variantes y archivos y crea los atajos del producto.
 */
export function ProductDetail({
  product,
  categories,
  canEdit,
  onClose,
  onEdit,
  onChanged,
  onDeleted,
  paused = false,
}: {
  product: CatalogProductDto;
  categories: CatalogCategoryDto[];
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  /** Vuelve a leer el catálogo tras un cambio. */
  onChanged: () => Promise<void>;
  onDeleted: () => void;
  /** Otro diálogo encima (editar producto): Escape es suyo. */
  paused?: boolean;
}) {
  const [variantDialog, setVariantDialog] = useState<
    { variant: CatalogVariantDto | null } | null
  >(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploadTarget, setUploadTarget] = useState("");
  const [shortcuts, setShortcuts] = useState<ShortcutOutcome[] | null>(null);
  const [lightbox, setLightbox] = useState<CatalogFileDto | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Al cambiar de producto se limpian los estados de la vista anterior.
  useEffect(() => {
    setConfirming(null);
    setError(null);
    setUploads([]);
    setUploadTarget("");
    setShortcuts(null);
    setLightbox(null);
  }, [product.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || variantDialog || paused) return;
      if (lightbox) setLightbox(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, variantDialog, paused, onClose]);

  const category = categories.find((c) => c.id === product.categoryId);
  const groups = groupFiles(product);
  const defaults = defaultShortcutsFor(product);
  const uploading = uploads.some((u) => u.status === "pending" || u.status === "uploading");
  const full = product.files.length >= CATALOG_LIMITS.maxFilesPerProduct;

  /** Una acción del Propietario: muestra el error del servidor y relee. */
  async function act(fn: () => Promise<Response | null>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (!res?.ok) {
      setError(await responseError(res, fallback));
      setBusy(false);
      return false;
    }
    await onChanged();
    setBusy(false);
    return true;
  }

  async function deleteProduct() {
    setBusy(true);
    setError(null);
    const res = await sendJson(`/api/catalog/products/${encodeURIComponent(product.id)}`, "DELETE");
    if (!res?.ok) {
      setError(await responseError(res, "No se pudo borrar el producto"));
      setBusy(false);
      return;
    }
    setBusy(false);
    onDeleted();
  }

  async function deleteVariant(v: CatalogVariantDto) {
    const ok = await act(
      () => sendJson(`/api/catalog/variants/${encodeURIComponent(v.id)}`, "DELETE"),
      "No se pudo borrar la variante"
    );
    if (ok) setConfirming(null);
  }

  async function deleteFile(f: CatalogFileDto) {
    const ok = await act(
      () => sendJson(`/api/catalog/files/${encodeURIComponent(f.id)}`, "DELETE"),
      "No se pudo borrar el archivo"
    );
    if (ok) setConfirming(null);
  }

  async function moveFileTo(f: CatalogFileDto, variantId: string | null) {
    await act(
      () => sendJson(`/api/catalog/files/${encodeURIComponent(f.id)}`, "PATCH", { variantId }),
      "No se pudo mover el archivo"
    );
  }

  async function reorder(list: CatalogFileDto[], index: number, dir: -1 | 1) {
    const patches = swapPositions(list, index, dir);
    if (patches.length === 0) return;
    await act(async () => {
      let last: Response | null = null;
      for (const p of patches) {
        last = await sendJson(`/api/catalog/files/${encodeURIComponent(p.id)}`, "PATCH", {
          position: p.position,
        });
        if (!last?.ok) return last;
      }
      return last;
    }, "No se pudo reordenar");
  }

  /** Sube uno por petición, en orden, con estado y error por archivo. */
  async function upload(files: File[]) {
    if (files.length === 0) return;
    const batch: Upload[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      name: f.name,
      status: "pending",
    }));
    setUploads(batch);
    setError(null);
    const set = (key: string, patch: Partial<Upload>) =>
      setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
    for (const [i, file] of files.entries()) {
      const item = batch[i];
      if (!item) continue;
      set(item.key, { status: "uploading" });
      // El navegador convierte WebP/GIF/HEIC a JPG y reduce lo que pase de
      // 5 MB; si no puede, sube el original y el servidor decide (415/413).
      const normalized = await normalizeImageFile(file, { maxBytes: UPLOAD_IMAGE_MAX_BYTES });
      const converted = normalizationSummary(normalized) ?? undefined;
      if (converted || normalized.note) set(item.key, { converted, note: normalized.note });
      const form = new FormData();
      form.append("file", normalized.file);
      if (uploadTarget) form.append("variantId", uploadTarget);
      const res = await fetch(
        `/api/catalog/products/${encodeURIComponent(product.id)}/files`,
        { method: "POST", body: form }
      ).catch(() => null);
      if (res?.ok) set(item.key, { status: "done", message: "Subido" });
      else set(item.key, { status: "error", message: await responseError(res, "No se pudo subir") });
    }
    await onChanged();
  }

  async function createShortcuts() {
    if (!defaults) return;
    setBusy(true);
    setShortcuts(null);
    const out: ShortcutOutcome[] = [];
    for (const s of defaults) {
      // `productId` + `attach` ligan el atajo al producto (FR-920); el cuerpo
      // usa `{{producto}}` (FR-921).
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shortcut: s.shortcut,
          title: s.title,
          body: s.body,
          productId: product.id,
          attach: s.attach,
        }),
      }).catch(() => null);
      const body = res && !res.ok ? await res.json().catch(() => null) : null;
      out.push(shortcutOutcome(s.shortcut, res?.status ?? null, body));
      setShortcuts([...out]);
    }
    setBusy(false);
  }

  return (
    <>
      <button
        aria-label="Cerrar el detalle del producto"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 hidden bg-overlay sm:block"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Producto ${product.name}`}
        data-testid="catalog-detail"
        data-product-id={product.id}
        className="fixed inset-0 z-50 flex flex-col bg-background shadow-pop sm:left-auto sm:w-[min(560px,100vw)] sm:border-l"
      >
        <header className="flex items-start gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words font-semibold">{product.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-3">
              {product.code && <code className="text-brand-text">{product.code}</code>}
              {category && <Badge variant="secondary">{category.name}</Badge>}
              {!product.active && <Badge variant="warning">Inactivo</Badge>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar detalle"
            className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" strokeWidth={1.7} />
          </button>
        </header>

        <div className="flex-1 space-y-0 overflow-y-auto">
          {canEdit && (
            <section className="space-y-2 border-b p-4">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
                  <Pencil className="h-4 w-4" />
                  Editar
                </Button>
                {/* Un botón deshabilitado no muestra tooltip: el `title` va
                    en el envoltorio y la razón, además, en texto. */}
                <span
                  title={
                    defaults
                      ? "Crea /fotos_<código> y /ficha_<código> ligados a este producto"
                      : `Necesita un código de hasta ${SHORTCUT_CODE_MAX} caracteres`
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !defaults}
                    onClick={() => void createShortcuts()}
                  >
                    <Zap className="h-4 w-4" />
                    Crear atajos
                  </Button>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger-text"
                  disabled={busy}
                  onClick={() => setConfirming(`product:${product.id}`)}
                >
                  <Trash2 className="h-4 w-4" />
                  Eliminar producto
                </Button>
              </div>
              {!defaults && (
                <p className="text-[11px] text-text-3">
                  «Crear atajos» necesita un código de hasta {SHORTCUT_CODE_MAX} caracteres.
                </p>
              )}
              {confirming === `product:${product.id}` && (
                <Confirm
                  text={`¿Eliminar «${product.name}»? Se borran sus variantes y archivos; los atajos ligados quedan sin producto.`}
                  busy={busy}
                  onConfirm={() => void deleteProduct()}
                  onCancel={() => setConfirming(null)}
                />
              )}
              {shortcuts && (
                <ul className="space-y-1 text-sm" aria-label="Resultado de crear atajos">
                  {shortcuts.map((s) => (
                    <li
                      key={s.shortcut}
                      data-testid="catalog-shortcut-result"
                      data-status={s.status}
                      className={cn(
                        s.status === "created" && "text-success-text",
                        s.status === "exists" && "text-text-2",
                        s.status === "error" && "text-danger-text"
                      )}
                    >
                      {s.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {error && (
            <p className="border-b bg-danger-tint px-4 py-2 text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}

          {/* Datos */}
          <section className="space-y-3 border-b p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-3">Precio</dt>
              <dd className="min-w-0 break-words">{product.price ?? "—"}</dd>
              {product.attributes.map((a, i) => (
                <AttrRow key={i} label={a.label} value={a.value} />
              ))}
            </dl>
            {product.description && (
              <p className="whitespace-pre-wrap break-words text-sm text-text-2">
                {product.description}
              </p>
            )}
          </section>

          {/* Variantes */}
          <section className="space-y-2 border-b p-4" aria-label="Variantes">
            <div className="flex items-center gap-2">
              <h4 className="flex-1 text-xs font-medium uppercase tracking-wide text-text-3">
                Variantes ({product.variants.length})
              </h4>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setVariantDialog({ variant: null })}
                >
                  <Plus className="h-4 w-4" />
                  Nueva variante
                </Button>
              )}
            </div>
            {product.variants.length === 0 && (
              <p className="text-sm text-text-3">Sin variantes.</p>
            )}
            <ul className="space-y-2">
              {product.variants.map((v) => {
                const price = variantPrice(product, v);
                return (
                  <li
                    key={v.id}
                    data-testid="catalog-variant"
                    data-variant-id={v.id}
                    className={cn("rounded-md border bg-card px-3 py-2", !v.active && "opacity-60")}
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{v.name}</span>
                          {v.code && <code className="text-xs text-brand-text">{v.code}</code>}
                          {!v.active && <Badge variant="warning">Inactiva</Badge>}
                        </p>
                        <p className="text-xs text-text-2">
                          {price.inherited
                            ? `Hereda el precio${price.text ? `: ${price.text}` : ""}`
                            : price.text}
                        </p>
                        {v.attributes.length > 0 && (
                          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                            {v.attributes.map((a, i) => (
                              <AttrRow key={i} label={a.label} value={a.value} />
                            ))}
                          </dl>
                        )}
                      </div>
                      {canEdit && (
                        <div className="flex items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Editar variante ${v.name}`}
                            disabled={busy}
                            onClick={() => setVariantDialog({ variant: v })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Eliminar variante ${v.name}`}
                            disabled={busy}
                            onClick={() => setConfirming(`variant:${v.id}`)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {confirming === `variant:${v.id}` && (
                      <Confirm
                        text={`¿Eliminar la variante «${v.name}»? Se borran sus archivos propios; los compartidos se quedan.`}
                        busy={busy}
                        onConfirm={() => void deleteVariant(v)}
                        onCancel={() => setConfirming(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Archivos */}
          <section className="space-y-3 p-4" aria-label="Archivos">
            <h4 className="text-xs font-medium uppercase tracking-wide text-text-3">
              Archivos ({product.files.length}/{CATALOG_LIMITS.maxFilesPerProduct})
            </h4>

            {canEdit && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor="cf-target" className="text-xs font-medium">
                      Pertenecen a
                    </label>
                    <select
                      id="cf-target"
                      value={uploadTarget}
                      disabled={uploading}
                      onChange={(e) => setUploadTarget(e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                    >
                      <option value="">Compartidos (todas las variantes)</option>
                      {product.variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    size="sm"
                    className="h-9"
                    disabled={uploading || full}
                    title={full ? `Tope de ${CATALOG_LIMITS.maxFilesPerProduct} archivos` : undefined}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    Subir archivos
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    accept={UPLOAD_ACCEPT}
                    aria-label="Archivos a subir"
                    data-testid="catalog-upload-input"
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      void upload(files);
                    }}
                  />
                </div>
                <p className="text-[11px] text-text-3">
                  Imágenes JPG o PNG (WebP, GIF y HEIC se convierten a JPG y las de más de
                  5 MB se reducen al subir) y documentos PDF, Word, Excel, PowerPoint, TXT o
                  CSV. Hasta {CATALOG_LIMITS.maxFilesPerProduct} por producto.
                </p>
                {uploads.length > 0 && (
                  <ul className="space-y-1 text-xs" aria-label="Subidas">
                    {uploads.map((u) => (
                      <li
                        key={u.key}
                        data-testid="catalog-upload"
                        data-status={u.status}
                        className="flex flex-wrap gap-x-2"
                      >
                        <span className="min-w-0 break-all font-medium">{u.name}</span>
                        <span
                          className={cn(
                            u.status === "error" && "text-danger-text",
                            u.status === "done" && "text-success-text",
                            (u.status === "pending" || u.status === "uploading") && "text-text-3"
                          )}
                        >
                          {u.status === "pending"
                            ? "En espera"
                            : u.status === "uploading"
                              ? "Subiendo…"
                              : u.message}
                        </span>
                        {u.converted && (
                          <span data-testid="catalog-upload-converted" className="text-text-3">
                            · {u.converted}
                          </span>
                        )}
                        {u.note && (
                          <span data-testid="catalog-upload-note" className="w-full text-warning-text">
                            {u.note}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {product.files.length === 0 && (
              <p className="text-sm text-text-3">Este producto aún no tiene archivos.</p>
            )}
            {product.files.length > 0 &&
              groups
                .filter((g) => g.files.length > 0)
                .map((g) => (
                  <FileGroupView
                    key={g.variantId ?? "shared"}
                    group={g}
                    product={product}
                    canEdit={canEdit}
                    busy={busy}
                    confirming={confirming}
                    onConfirm={setConfirming}
                    onOpen={setLightbox}
                    onDelete={(f) => void deleteFile(f)}
                    onMove={(f, v) => void moveFileTo(f, v)}
                    onReorder={(list, i, dir) => void reorder(list, i, dir)}
                  />
                ))}
          </section>
        </div>
      </aside>

      {lightbox && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Imagen ${lightbox.fileName}`}
        >
          <button
            onClick={() => setLightbox(null)}
            aria-label="Cerrar imagen"
            className="absolute right-3 top-3 rounded-full bg-card p-2 text-foreground shadow-pop"
          >
            <X className="h-5 w-5" />
          </button>
          <div onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full">
            <CatalogThumb
              src={lightbox.url}
              alt={lightbox.fileName}
              className="max-h-[85vh] max-w-full rounded-md object-contain"
            />
            <p className="mt-2 truncate text-center text-xs text-white">{lightbox.fileName}</p>
          </div>
        </div>
      )}

      {variantDialog && (
        <VariantDialog
          product={product}
          variant={variantDialog.variant}
          onClose={() => setVariantDialog(null)}
          onSaved={() => {
            setVariantDialog(null);
            void onChanged();
          }}
        />
      )}
    </>
  );
}

function AttrRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-text-3">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
}

function Confirm({
  text,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="catalog-confirm">
      <span className="text-sm text-danger-text">{text}</span>
      <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
        Eliminar
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
        Cancelar
      </Button>
    </div>
  );
}

/**
 * Un grupo de archivos (compartidos o de una variante): galería de imágenes
 * y lista de documentos. Ordenar mueve dentro del mismo tipo del grupo —así
 * se muestran y así salen las fotos o las fichas de un atajo—.
 */
function FileGroupView({
  group,
  product,
  canEdit,
  busy,
  confirming,
  onConfirm,
  onOpen,
  onDelete,
  onMove,
  onReorder,
}: {
  group: FileGroup;
  product: CatalogProductDto;
  canEdit: boolean;
  busy: boolean;
  confirming: string | null;
  onConfirm: (key: string | null) => void;
  onOpen: (f: CatalogFileDto) => void;
  onDelete: (f: CatalogFileDto) => void;
  onMove: (f: CatalogFileDto, variantId: string | null) => void;
  onReorder: (list: CatalogFileDto[], index: number, dir: -1 | 1) => void;
}) {
  const images = group.files.filter((f) => f.kind === "image");
  const docs = group.files.filter((f) => f.kind === "document");

  function controls(f: CatalogFileDto, list: CatalogFileDto[], i: number) {
    if (!canEdit) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={`Mover arriba ${f.fileName}`}
          disabled={busy || i === 0}
          onClick={() => onReorder(list, i, -1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={`Mover abajo ${f.fileName}`}
          disabled={busy || i === list.length - 1}
          onClick={() => onReorder(list, i, 1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={`Eliminar archivo ${f.fileName}`}
          disabled={busy}
          onClick={() => onConfirm(`file:${f.id}`)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <select
          aria-label={`Variante de ${f.fileName}`}
          value={f.variantId ?? ""}
          disabled={busy}
          onChange={(e) => onMove(f, e.target.value || null)}
          className="h-7 min-w-0 max-w-full flex-1 rounded-md border border-input bg-card px-1 text-xs"
        >
          <option value="">Compartido</option>
          {product.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  function confirmFor(f: CatalogFileDto) {
    if (confirming !== `file:${f.id}`) return null;
    return (
      <Confirm
        text={`¿Eliminar ${f.fileName}?`}
        busy={busy}
        onConfirm={() => onDelete(f)}
        onCancel={() => onConfirm(null)}
      />
    );
  }

  return (
    <div className="space-y-2" data-testid="catalog-file-group" data-variant-id={group.variantId ?? ""}>
      <h5 className="text-sm font-medium">{group.label}</h5>
      {images.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((f, i) => (
            <li
              key={f.id}
              data-testid="catalog-file"
              data-file-id={f.id}
              data-kind="image"
              className="min-w-0 space-y-1"
            >
              <button
                type="button"
                onClick={() => onOpen(f)}
                aria-label={`Ver ${f.fileName}`}
                className="block w-full overflow-hidden rounded-md border"
              >
                <CatalogThumb src={f.url} alt={f.fileName} className="aspect-square w-full" />
              </button>
              <p className="truncate text-[11px] text-text-3" title={f.fileName}>
                {f.fileName}
              </p>
              {controls(f, images, i)}
              {confirmFor(f)}
            </li>
          ))}
        </ul>
      )}
      {docs.length > 0 && (
        <ul className="space-y-1.5">
          {docs.map((f, i) => (
            <li
              key={f.id}
              data-testid="catalog-file"
              data-file-id={f.id}
              data-kind="document"
              className="rounded-md border bg-card px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-text-3" />
                <a
                  href={f.url}
                  download={f.fileName}
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                  title={`Descargar ${f.fileName}`}
                >
                  {f.fileName}
                </a>
                <span className="shrink-0 text-[11px] text-text-3">{formatBytes(f.size)}</span>
                <a
                  href={f.url}
                  download={f.fileName}
                  aria-label={`Descargar ${f.fileName}`}
                  className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
              {canEdit && <div className="mt-1">{controls(f, docs, i)}</div>}
              {confirmFor(f)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
