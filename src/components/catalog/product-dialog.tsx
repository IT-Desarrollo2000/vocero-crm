"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CATALOG_LIMITS,
  type CatalogCategoryDto,
  type CatalogProductDto,
  type CatalogVariantDto,
  type ProductCreateBody,
  type VariantCreateBody,
} from "@/lib/catalog";
import { AttributesEditor, CatalogDialog, Field } from "./catalog-dialog";
import { cleanAttributes, responseError, sendJson, type AttributeRow } from "./catalog-view";

const CODE_HINT = "Opcional. 1 a 32 letras, números, - o _. Único entre productos y variantes.";

function validCode(code: string): boolean {
  return !code.trim() || CATALOG_LIMITS.codePattern.test(code.trim());
}

/**
 * Alta / edición de un producto (solo Propietario). Un campo vacío BORRA el
 * valor (la API convierte "" en null); una fila de atributo a medias se
 * avisa en vez de mandarse.
 */
export function ProductDialog({
  product,
  categories,
  defaultCategoryId,
  onClose,
  onSaved,
}: {
  /** null = alta. */
  product: CatalogProductDto | null;
  categories: CatalogCategoryDto[];
  defaultCategoryId?: string | null;
  onClose: () => void;
  onSaved: (product: CatalogProductDto) => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [code, setCode] = useState(product?.code ?? "");
  const [categoryId, setCategoryId] = useState(
    product ? (product.categoryId ?? "") : (defaultCategoryId ?? "")
  );
  const [price, setPrice] = useState(product?.price ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [rows, setRows] = useState<AttributeRow[]>(product?.attributes ?? []);
  const [active, setActive] = useState(product?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("El nombre es obligatorio.");
    if (!validCode(code)) return setError("Código inválido: 1-32 letras, números, guion o guion bajo.");
    const { attributes, incomplete } = cleanAttributes(rows);
    if (incomplete) return setError("Cada atributo necesita etiqueta y valor (o quítalo).");
    setSaving(true);
    setError(null);
    const body: ProductCreateBody = {
      name: name.trim(),
      code: code.trim() || null,
      categoryId: categoryId || null,
      price: price.trim() || null,
      description: description.trim() || null,
      attributes,
      active,
    };
    const res = await sendJson(
      product ? `/api/catalog/products/${encodeURIComponent(product.id)}` : "/api/catalog/products",
      product ? "PATCH" : "POST",
      body
    );
    if (!res?.ok) {
      setSaving(false);
      setError(await responseError(res, "No se pudo guardar el producto"));
      return;
    }
    const data = (await res.json()) as { product: CatalogProductDto };
    onSaved(data.product);
  }

  const title = product ? "Editar producto" : "Nuevo producto";
  return (
    <CatalogDialog title={title} onClose={onClose} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id="cp-name" label="Nombre">
          <Input
            id="cp-name"
            value={name}
            maxLength={CATALOG_LIMITS.productNameMax}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cp-code" label="Código" hint={CODE_HINT}>
            <Input
              id="cp-code"
              value={code}
              maxLength={32}
              placeholder="T03"
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field id="cp-category" label="Categoría">
            <select
              id="cp-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id="cp-price" label="Precio" hint="Texto libre: «desde $589,900», «$1,200 + IVA»…">
          <Input
            id="cp-price"
            value={price}
            maxLength={CATALOG_LIMITS.priceMax}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field id="cp-description" label="Descripción">
          <Textarea
            id="cp-description"
            rows={4}
            value={description}
            maxLength={CATALOG_LIMITS.descriptionMax}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <AttributesEditor rows={rows} onChange={setRows} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="accent-primary"
          />
          Activo
          <span className="text-xs text-text-3">
            (inactivo: atenuado aquí y fuera del compositor y los atajos)
          </span>
        </label>
        {error && (
          <p className="text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </CatalogDialog>
  );
}

/** Alta / edición de una variante (solo Propietario). Sin precio = hereda. */
export function VariantDialog({
  product,
  variant,
  onClose,
  onSaved,
}: {
  product: CatalogProductDto;
  /** null = alta. */
  variant: CatalogVariantDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(variant?.name ?? "");
  const [code, setCode] = useState(variant?.code ?? "");
  const [price, setPrice] = useState(variant?.price ?? "");
  const [rows, setRows] = useState<AttributeRow[]>(variant?.attributes ?? []);
  const [active, setActive] = useState(variant?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("El nombre es obligatorio.");
    if (!validCode(code)) return setError("Código inválido: 1-32 letras, números, guion o guion bajo.");
    const { attributes, incomplete } = cleanAttributes(rows);
    if (incomplete) return setError("Cada atributo necesita etiqueta y valor (o quítalo).");
    setSaving(true);
    setError(null);
    const body: VariantCreateBody = {
      name: name.trim(),
      code: code.trim() || null,
      price: price.trim() || null,
      attributes,
      active,
    };
    const res = await sendJson(
      variant
        ? `/api/catalog/variants/${encodeURIComponent(variant.id)}`
        : `/api/catalog/products/${encodeURIComponent(product.id)}/variants`,
      variant ? "PATCH" : "POST",
      body
    );
    if (!res?.ok) {
      setSaving(false);
      setError(await responseError(res, "No se pudo guardar la variante"));
      return;
    }
    onSaved();
  }

  const title = variant ? "Editar variante" : "Nueva variante";
  return (
    <CatalogDialog title={title} description={product.name} onClose={onClose} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id="cv-name" label="Nombre">
          <Input
            id="cv-name"
            value={name}
            maxLength={CATALOG_LIMITS.variantNameMax}
            placeholder="400 km"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cv-code" label="Código" hint={CODE_HINT}>
            <Input
              id="cv-code"
              value={code}
              maxLength={32}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field
            id="cv-price"
            label="Precio"
            hint={
              product.price
                ? `Vacío = hereda el del producto (${product.price}).`
                : "Vacío = hereda el del producto."
            }
          >
            <Input
              id="cv-price"
              value={price}
              maxLength={CATALOG_LIMITS.priceMax}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
        </div>
        <AttributesEditor rows={rows} onChange={setRows} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="accent-primary"
          />
          Activo
        </label>
        {error && (
          <p className="text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </CatalogDialog>
  );
}
