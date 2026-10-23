"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QUICK_REPLY_LIMITS, normalizeShortcut } from "@/lib/quick-replies";
import type { QuickReplyCreateBody, QuickReplyDto } from "@/lib/types";
import {
  QUICK_REPLY_VAR_HELP,
  TEXT_ONLY_VARS,
  quickReplyErrorMessage,
  validateQuickReplyForm,
} from "@/components/settings/quick-reply-form";

/**
 * 029 (US-1) — Alta de una respuesta rápida desde el compositor: lo abren
 * «+ Nueva respuesta rápida» (al final del menú `/`) y «Guardar como
 * respuesta rápida» (prellena el texto con lo escrito). Solo texto: ligar un
 * producto es del Propietario, en Ajustes. Un atajo repetido (409) se avisa
 * en el diálogo sin perder nada: ni lo de aquí ni lo escrito en el
 * compositor, que este diálogo no toca.
 */
export function QuickReplyDialog({
  initialShortcut = "",
  initialBody = "",
  onClose,
  onCreated,
}: {
  initialShortcut?: string;
  initialBody?: string;
  onClose: () => void;
  onCreated: (reply: QuickReplyDto) => void;
}) {
  const [shortcut, setShortcut] = useState(initialShortcut);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  // El compositor re-renderiza seguido (SSE, cursor): `onClose` llega nuevo en
  // cada render, así que se lee de un ref y el foco se pone UNA vez.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // Con el atajo ya puesto (desde `/atajo`), el foco va al título.
    firstRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function insertVar(name: string) {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  }

  async function save() {
    const invalid = validateQuickReplyForm({ shortcut, title, body });
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    const payload: QuickReplyCreateBody = {
      shortcut: normalizeShortcut(shortcut),
      title: title.trim(),
      body,
    };
    const res = await fetch("/api/quick-replies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (!res?.ok) {
      setSaving(false);
      setError(await quickReplyErrorMessage(res, "No se pudo guardar la respuesta"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { quickReply?: QuickReplyDto } | null;
    setSaving(false);
    if (data?.quickReply) onCreated(data.quickReply);
    else onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-center bg-overlay sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nueva respuesta rápida"
        className="flex w-full flex-col overflow-y-auto border bg-card p-5 shadow-xl sm:max-h-[90vh] sm:max-w-lg sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start gap-2">
          <h3 className="flex-1 font-semibold">Nueva respuesta rápida</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1 -mt-1 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-text-3">
          Queda para todo el equipo: en la Bandeja, escribe <code>/</code> y el atajo.
        </p>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="qrd-shortcut">Atajo</Label>
              <div className="flex items-center rounded-md border border-input bg-card pl-2.5 focus-within:border-brand">
                <span className="text-sm text-text-3">/</span>
                <Input
                  id="qrd-shortcut"
                  ref={initialShortcut ? undefined : firstRef}
                  value={shortcut}
                  maxLength={33}
                  placeholder="horario"
                  onChange={(e) => setShortcut(e.target.value)}
                  className="border-0 pl-1 shadow-none focus-visible:ring-0"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qrd-title">Título</Label>
              <Input
                id="qrd-title"
                ref={initialShortcut ? firstRef : undefined}
                value={title}
                maxLength={QUICK_REPLY_LIMITS.titleMax}
                placeholder="Horario de atención"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qrd-body">Texto</Label>
            <Textarea
              id="qrd-body"
              ref={bodyRef}
              rows={5}
              value={body}
              maxLength={QUICK_REPLY_LIMITS.bodyMax}
              placeholder="Hola {{nombre}}, abrimos de lunes a sábado de 9 a 6."
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-3">
              <span>Variables:</span>
              {TEXT_ONLY_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  title={QUICK_REPLY_VAR_HELP[v]}
                  aria-label={`Insertar variable ${v}: ${QUICK_REPLY_VAR_HELP[v]}`}
                  onClick={() => insertVar(v)}
                  className="rounded-full border bg-secondary px-2 py-0.5 font-mono text-[11px] text-text-2 hover:border-brand-soft hover:bg-brand-tint hover:text-brand-text"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-3">
              Si falta el dato, la variable se omite.
            </p>
          </div>
          {error && (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={saving || !shortcut.trim() || !title.trim() || !body.trim()}
            >
              <Plus className="h-4 w-4" />
              {saving ? "Guardando…" : "Crear respuesta"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
