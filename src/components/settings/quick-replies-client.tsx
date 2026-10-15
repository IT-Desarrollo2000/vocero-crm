"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useViewer } from "@/components/viewer-context";
import {
  QUICK_REPLY_LIMITS,
  QUICK_REPLY_VARS,
  findUnknownVars,
  renderQuickReply,
} from "@/lib/quick-replies";
import type {
  QuickReplyCreateBody,
  QuickReplyDto,
  QuickReplyPatchBody,
} from "@/lib/types";
import { movePositions } from "@/components/inbox/quick-reply-render";
import {
  filesForAttach,
  type CatalogDto,
  type CatalogProductDto,
  type QuickReplyAttach,
} from "@/lib/catalog";

/** 019: etiqueta de cada opción de "Enviar". */
const ATTACH_LABEL: Record<QuickReplyAttach, string> = {
  images: "Fotos",
  documents: "Documentos",
  all: "Todo",
};

type ApiError = { error?: { code?: string; message?: string } } | null;

/** Ayuda de cada variable, en el orden de `QUICK_REPLY_VARS`. */
const VAR_HELP: Record<(typeof QUICK_REPLY_VARS)[number], string> = {
  nombre: "primer nombre del cliente",
  nombre_completo: "nombre completo del cliente",
  vendedor: "tu nombre o el de quien envía",
  negocio: "nombre de tu Marca",
  producto: "nombre del producto ligado (solo si la respuesta tiene producto)",
};

/** Mensaje del servidor si lo hay; si no, uno por código. */
async function errorMessage(res: Response | null, fallback: string) {
  if (!res) return "Sin conexión con el servidor";
  if (res.status === 501) {
    return "Las respuestas rápidas aún no están disponibles en este servidor.";
  }
  const data = (await res.json().catch(() => null)) as ApiError;
  switch (data?.error?.code) {
    case "duplicate_shortcut":
      return data.error.message ?? "Ya existe una respuesta con ese atajo.";
    case "unknown_variable":
      return data.error.message ?? "El texto usa una variable desconocida.";
    case "not_found":
      return "Esa respuesta ya no existe. Recarga la página.";
    default:
      return data?.error?.message ?? fallback;
  }
}

/** Atajo como lo guarda el servidor: sin `/` inicial, sin espacios, minúsculas. */
function normalizeShortcutInput(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

/** Validación previa al envío (el servidor valida igual). */
function validate(form: {
  shortcut: string;
  title: string;
  body: string;
  productId: string;
}): string | null {
  const shortcut = normalizeShortcutInput(form.shortcut);
  if (!QUICK_REPLY_LIMITS.shortcutPattern.test(shortcut)) {
    return "El atajo lleva de 1 a 32 caracteres: letras minúsculas, números, - o _.";
  }
  const title = form.title.trim();
  if (!title || title.length > QUICK_REPLY_LIMITS.titleMax) {
    return `El título lleva de 1 a ${QUICK_REPLY_LIMITS.titleMax} caracteres.`;
  }
  // 019: el texto puede ir vacío solo si la respuesta adjunta un producto.
  if ((!form.body.trim() && !form.productId) || form.body.length > QUICK_REPLY_LIMITS.bodyMax) {
    return `El texto lleva de 1 a ${QUICK_REPLY_LIMITS.bodyMax} caracteres (puede ir vacío si eliges un producto).`;
  }
  const unknown = findUnknownVars(form.body, { product: !!form.productId });
  if (unknown.length > 0) {
    return `Variable desconocida: ${unknown.map((v) => `{{${v}}}`).join(", ")}`;
  }
  return null;
}

const EMPTY: {
  shortcut: string;
  title: string;
  body: string;
  /** 019: "" = sin producto. */
  productId: string;
  attach: QuickReplyAttach;
} = { shortcut: "", title: "", body: "", productId: "", attach: "images" };

/**
 * 09 — Ajustes → Respuestas rápidas (solo Propietario). Catálogo único de la
 * organización: el equipo lo usa escribiendo `/` en el compositor.
 */
export function QuickRepliesClient() {
  const viewer = useViewer();
  const [list, setList] = useState<QuickReplyDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // 019: productos para ligar una respuesta (GET /api/catalog). Si falla, el
  // selector solo ofrece "Ninguno" y las respuestas de texto siguen igual.
  const [products, setProducts] = useState<CatalogProductDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/catalog").catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json().catch(() => null)) as CatalogDto | null;
      if (!cancelled && Array.isArray(data?.products)) setProducts(data.products);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/quick-replies").catch(() => null);
    if (!res?.ok) {
      setLoadError(await errorMessage(res, "No se pudieron cargar las respuestas rápidas"));
      return;
    }
    const data = (await res.json()) as { quickReplies: QuickReplyDto[] };
    setLoadError(null);
    setList([...data.quickReplies].sort((a, b) => a.position - b.position));
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Vista previa con datos de ejemplo (y el nombre real de quien escribe).
  const linked = products.find((p) => p.id === form.productId) ?? null;
  const sample = {
    nombre: "María",
    nombreCompleto: "María López",
    vendedor: viewer.name,
    negocio: viewer.businessName,
    producto: linked?.name ?? "",
  };
  /** Vista previa de una fila de la lista, con SU producto. */
  const sampleFor = (r: QuickReplyDto) => ({ ...sample, producto: r.product?.name ?? "" });

  function insertVar(name: string) {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? form.body.length;
    const end = el?.selectionEnd ?? form.body.length;
    const body = form.body.slice(0, start) + token + form.body.slice(end);
    setForm((f) => ({ ...f, body }));
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  }

  function startEdit(r: QuickReplyDto) {
    setEditingId(r.id);
    setForm({
      shortcut: r.shortcut,
      title: r.title,
      body: r.body,
      productId: r.productId ?? "",
      attach: r.attach ?? "images",
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY);
    setError(null);
  }

  async function save() {
    const invalid = validate(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    const payload: QuickReplyCreateBody | QuickReplyPatchBody = {
      shortcut: normalizeShortcutInput(form.shortcut),
      title: form.title.trim(),
      body: form.body,
      // 019: sin producto se manda null (en PATCH, desliga).
      productId: form.productId || null,
      attach: form.productId ? form.attach : null,
    };
    const res = await fetch(
      editingId
        ? `/api/quick-replies/${encodeURIComponent(editingId)}`
        : "/api/quick-replies",
      {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    ).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await errorMessage(res, "No se pudo guardar la respuesta"));
      return;
    }
    setEditingId(null);
    setForm(EMPTY);
    void refetch();
  }

  async function remove(r: QuickReplyDto) {
    setBusyId(r.id);
    setRowError(null);
    const res = await fetch(`/api/quick-replies/${encodeURIComponent(r.id)}`, {
      method: "DELETE",
    }).catch(() => null);
    setBusyId(null);
    if (!res?.ok) {
      setRowError({ id: r.id, message: await errorMessage(res, "No se pudo borrar") });
      return;
    }
    setConfirmingId(null);
    if (editingId === r.id) cancelEdit();
    void refetch();
  }

  async function move(index: number, to: number) {
    const target = list[index];
    if (!target) return;
    const patches = movePositions(list, index, to);
    if (patches.length === 0) return;
    setBusyId(target.id);
    setRowError(null);
    for (const p of patches) {
      const body: QuickReplyPatchBody = { position: p.position };
      const res = await fetch(`/api/quick-replies/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) {
        setRowError({ id: target.id, message: await errorMessage(res, "No se pudo reordenar") });
        break;
      }
    }
    setBusyId(null);
    void refetch();
  }

  const preview = form.body ? renderQuickReply(form.body, sample) : "";

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Editar respuesta rápida" : "Nueva respuesta rápida"}</CardTitle>
          <CardDescription>
            Textos oficiales del negocio para que el equipo conteste en
            segundos: en la Bandeja, escribe <code>/</code> y el atajo. Solo se
            ofrecen con la ventana de 24 horas abierta; fuera de ella, como
            siempre, solo plantillas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[180px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="qr-shortcut">Atajo</Label>
              <div className="flex items-center rounded-md border border-input bg-card pl-2.5 focus-within:border-brand">
                <span className="text-sm text-text-3">/</span>
                <Input
                  id="qr-shortcut"
                  value={form.shortcut}
                  maxLength={33}
                  placeholder="horario"
                  onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))}
                  className="border-0 pl-1 shadow-none focus-visible:ring-0"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qr-title">Título</Label>
              <Input
                id="qr-title"
                value={form.title}
                maxLength={QUICK_REPLY_LIMITS.titleMax}
                placeholder="Horario de atención"
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qr-body">Texto</Label>
            <Textarea
              id="qr-body"
              ref={bodyRef}
              rows={5}
              value={form.body}
              maxLength={QUICK_REPLY_LIMITS.bodyMax}
              placeholder="Hola {{nombre}}, abrimos de lunes a sábado de 9 a 6."
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-3">
              <span>Variables:</span>
              {QUICK_REPLY_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  title={VAR_HELP[v]}
                  aria-label={`Insertar variable ${v}: ${VAR_HELP[v]}`}
                  onClick={() => insertVar(v)}
                  className="rounded-full border bg-secondary px-2 py-0.5 font-mono text-[11px] text-text-2 hover:border-brand-soft hover:bg-brand-tint hover:text-brand-text"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-3">
              {QUICK_REPLY_VARS.map((v) => `{{${v}}} = ${VAR_HELP[v]}`).join(" · ")}.
              Si falta el dato, la variable se omite.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qr-product">Producto del catálogo</Label>
            <select
              id="qr-product"
              value={form.productId}
              onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}
              className="w-full rounded-md border border-input bg-card px-2.5 py-2 text-sm outline-none focus:border-brand"
            >
              <option value="">Ninguno (solo texto)</option>
              {/* Uno ya ligado que se desactivó sigue en la lista para no perderlo. */}
              {products
                .filter((p) => p.active || p.id === form.productId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.code ? ` (${p.code})` : ""}
                    {p.active ? "" : " — inactivo"}
                  </option>
                ))}
            </select>
            {linked && (
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Enviar</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(Object.keys(ATTACH_LABEL) as QuickReplyAttach[]).map((a) => (
                    <label key={a} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="qr-attach"
                        value={a}
                        checked={form.attach === a}
                        onChange={() => setForm((f) => ({ ...f, attach: a }))}
                      />
                      {ATTACH_LABEL[a]} ({filesForAttach(linked, a).length})
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-text-3">
                  Al elegir la respuesta en la Bandeja se agregan{" "}
                  {filesForAttach(linked, form.attach).length} archivo(s) de {linked.name}{" "}
                  debajo del texto; nada sale hasta que se pulse enviar. Con producto,
                  el texto es opcional.
                </p>
              </fieldset>
            )}
          </div>
          {preview && (
            <div className="rounded-md border bg-secondary px-3 py-2 text-sm">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-3">
                Vista previa (cliente «María López»)
              </p>
              <p className="whitespace-pre-wrap break-words">{preview}</p>
            </div>
          )}
          {error && (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                saving ||
                !form.shortcut.trim() ||
                !form.title.trim() ||
                (!form.body.trim() && !form.productId)
              }
              onClick={() => void save()}
            >
              {editingId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear respuesta"}
            </Button>
            {editingId && (
              <Button variant="outline" disabled={saving} onClick={cancelEdit}>
                Cancelar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Catálogo
        </p>
        {loadError && (
          <p className="text-sm text-danger-text" role="alert">
            {loadError}
          </p>
        )}
        {!loadError && list.length === 0 && (
          <p className="text-sm text-text-3">
            Todavía no hay respuestas rápidas. Crea la primera arriba.
          </p>
        )}
        <ul className="space-y-2" aria-label="Respuestas rápidas del negocio">
          {list.map((r, i) => {
            const busy = busyId === r.id;
            const confirming = confirmingId === r.id;
            return (
              <li key={r.id} className="rounded-lg border bg-card px-4 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-2 text-sm">
                      <code className="font-semibold text-brand-text">/{r.shortcut}</code>
                      <span className="font-medium">{r.title}</span>
                    </p>
                    {r.body && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text-3">
                        {renderQuickReply(r.body, sampleFor(r))}
                      </p>
                    )}
                    {r.product ? (
                      <p className="mt-1 text-xs text-text-2">
                        Producto: <span className="font-medium">{r.product.name}</span>
                        {r.attach ? ` · ${ATTACH_LABEL[r.attach]}` : ""} ·{" "}
                        {r.product.files.length} archivo(s)
                        {!r.product.active && (
                          <span className="ml-1.5 rounded bg-warning-tint px-1.5 py-0.5 text-[11px] text-warning-text">
                            Producto inactivo · no se ofrece
                          </span>
                        )}
                      </p>
                    ) : (
                      !r.body.trim() && (
                        <p className="mt-1">
                          <span className="rounded bg-warning-tint px-1.5 py-0.5 text-[11px] text-warning-text">
                            Sin producto · sin texto: no se ofrece. Edítala o bórrala.
                          </span>
                        </p>
                      )
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Subir ${r.title}`}
                      disabled={busyId !== null || i === 0}
                      onClick={() => void move(i, i - 1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Bajar ${r.title}`}
                      disabled={busyId !== null || i === list.length - 1}
                      onClick={() => void move(i, i + 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Editar ${r.title}`}
                      disabled={busy}
                      onClick={() => startEdit(r)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Borrar ${r.title}`}
                      disabled={busy}
                      onClick={() => {
                        setRowError(null);
                        setConfirmingId(r.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {confirming && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-danger-text">
                      ¿Borrar /{r.shortcut}? Lo ya enviado no cambia.
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove(r)}
                    >
                      {busy ? "Borrando…" : "Sí, borrar"}
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
                {rowError?.id === r.id && (
                  <p className="mt-2 text-sm text-danger-text" role="alert">
                    {rowError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
