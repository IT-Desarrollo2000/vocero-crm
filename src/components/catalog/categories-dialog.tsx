"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CATALOG_LIMITS, type CatalogCategoryDto } from "@/lib/catalog";
import { CatalogDialog } from "./catalog-dialog";
import { responseError, sendJson } from "./catalog-view";

/**
 * Gestión de categorías (solo Propietario): crear, renombrar y borrar. Borrar
 * deja sus productos "Sin categoría" (FR-908), por eso se confirma.
 */
export function CategoriesDialog({
  categories,
  onClose,
  onChanged,
}: {
  categories: CatalogCategoryDto[];
  onClose: () => void;
  /** Tras cada cambio: el padre vuelve a leer el catálogo. */
  onChanged: () => Promise<void> | void;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<Response | null>, fallback: string): Promise<boolean> {
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

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const ok = await run(
      () => sendJson("/api/catalog/categories", "POST", { name }),
      "No se pudo crear la categoría"
    );
    if (ok) setNewName("");
  }

  async function rename() {
    if (!editing || !editing.name.trim()) return;
    const ok = await run(
      () =>
        sendJson(`/api/catalog/categories/${encodeURIComponent(editing.id)}`, "PATCH", {
          name: editing.name.trim(),
        }),
      "No se pudo renombrar la categoría"
    );
    if (ok) setEditing(null);
  }

  async function remove(id: string) {
    const ok = await run(
      () => sendJson(`/api/catalog/categories/${encodeURIComponent(id)}`, "DELETE"),
      "No se pudo borrar la categoría"
    );
    if (ok) setConfirmingId(null);
  }

  return (
    <CatalogDialog
      title="Categorías"
      description="Un solo nivel. Borrar una categoría deja sus productos sin categoría."
      onClose={onClose}
    >
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input
          aria-label="Nueva categoría"
          placeholder="Nueva categoría"
          value={newName}
          maxLength={CATALOG_LIMITS.categoryNameMax}
          onChange={(e) => setNewName(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={busy || !newName.trim()}>
          <Plus className="h-4 w-4" />
          Crear categoría
        </Button>
      </form>

      {categories.length === 0 && (
        <p className="text-sm text-text-3">Todavía no hay categorías.</p>
      )}
      <ul className="space-y-2" aria-label="Categorías del catálogo">
        {categories.map((c) => {
          const isEditing = editing?.id === c.id;
          return (
            <li
              key={c.id}
              data-testid="catalog-category"
              className="rounded-md border bg-secondary/40 px-3 py-2"
            >
              {isEditing ? (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename();
                  }}
                >
                  <Input
                    aria-label={`Nombre de la categoría ${c.name}`}
                    value={editing.name}
                    maxLength={CATALOG_LIMITS.categoryNameMax}
                    onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                    className="min-w-0 flex-1"
                    autoFocus
                  />
                  <Button type="submit" size="sm" disabled={busy || !editing.name.trim()}>
                    Guardar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancelar
                  </Button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Renombrar ${c.name}`}
                    disabled={busy}
                    onClick={() => {
                      setConfirmingId(null);
                      setEditing({ id: c.id, name: c.name });
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Borrar ${c.name}`}
                    disabled={busy}
                    onClick={() => setConfirmingId(c.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
              {confirmingId === c.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-danger-text">
                    ¿Borrar «{c.name}»? Sus productos quedan sin categoría.
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(c.id)}
                  >
                    Eliminar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingId(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-3 text-sm text-danger-text" role="alert">
          {error}
        </p>
      )}
    </CatalogDialog>
  );
}
