"use client";

import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  FileText,
  Package,
  MapPin,
  Paperclip,
  Send,
  UserRound,
  X,
} from "lucide-react";
import type { ConversationDto, QuickReplyDto, TemplateDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useViewer } from "@/components/viewer-context";
import { formatBytes, formatRemaining } from "./helpers";
import { TemplateSender } from "./template-sender";
import { useQuickReplies } from "./use-quick-replies";
import {
  QUICK_REPLY_LISTBOX_ID,
  QuickReplyPicker,
  quickReplyOptionId,
} from "./quick-reply-picker";
import {
  matchQuickReplies,
  renderQuickReply,
  slashQuery,
} from "@/lib/quick-replies";
import { insertQuickReply, quickReplyContext } from "./quick-reply-render";
import {
  CATALOG_LIMITS,
  fileCompatibility,
  type CatalogBatchResult,
  type CatalogFileDto,
} from "@/lib/catalog";
import {
  catalogBatchBody,
  quickReplyFiles,
  splitStaged,
  stageFiles,
  stagedAfterSend,
  summarizeBatch,
  visibleQuickReplies,
} from "./catalog-staging";
import { useCatalog } from "./use-catalog";
import { CatalogPanel } from "./catalog-panel";
import {
  CONVERTIBLE_IMAGE_ACCEPT,
  normalizationSummary,
  normalizeImageFile,
  planImageNormalization,
} from "@/lib/image-normalize";
import type { OutboundFiles } from "@/lib/outbound-files";

/** Máximo de opciones visibles en el selector `/`. */
const QUICK_REPLY_PICKER_MAX = 8;

/** 008 — Panel secundario del clip: formulario de ubicación o contacto. */
type AttachPanel = "location" | "contact" | null;

/** 018 — ¿La extensión del archivo está en el `accept` del canal? */
function extensionAllowed(name: string, accept: string): boolean {
  const lower = name.toLowerCase();
  return accept
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."))
    .some((e) => lower.endsWith(e));
}

/** 018/019 — Tope de imagen del canal; null si el canal no manda imágenes. */
function imageMaxBytes(files: OutboundFiles | null | undefined): number | null {
  return files?.rules.find((r) => r.kind === "image")?.maxBytes ?? null;
}

/**
 * `accept` del clip: el del canal y, si el canal manda imágenes, además
 * WebP/GIF/HEIC/HEIF (el navegador los convierte a JPG antes de subir).
 */
function clipAccept(files: OutboundFiles | null | undefined): string | undefined {
  if (!files) return undefined;
  return imageMaxBytes(files) !== null
    ? `${files.accept},${CONVERTIBLE_IMAGE_ACCEPT}`
    : files.accept;
}

/** Vista previa solo para lo que el navegador sabe pintar (no HEIC). */
const PREVIEWABLE = /^image\/(jpeg|png|gif|webp)$/;

/** Extrae lat,long de "21.019, -101.257" o de un enlace de Google Maps. */
function parseCoords(raw: string): { latitude: number; longitude: number } | null {
  const m =
    raw.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/) ??
    raw.match(/@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export function Composer({
  conversation,
  onSend,
  onSent,
  onNotVisible,
}: {
  conversation: ConversationDto;
  onSend: (text: string) => Promise<string | null>;
  onSent: () => void;
  /** 09: un envío respondió 404 — la conversación ya la atiende otro. */
  onNotVisible?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  // Aviso de la conversión en el navegador ("convertida a JPG", "no se pudo…").
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [panel, setPanel] = useState<AttachPanel>(null);
  const [coordsRaw, setCoordsRaw] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  // 019 — Archivos del catálogo escenificados como chips (FR-930..933).
  const [staged, setStaged] = useState<CatalogFileDto[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogState = useCatalog();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 09 — Respuestas rápidas: `/atajo` al inicio o tras un espacio abre el
  // selector; Esc lo cierra hasta que se escriba otra `/`.
  const viewer = useViewer();
  const { quickReplies: allQuickReplies, reload: reloadQuickReplies } = useQuickReplies();
  // 019: sin las ligadas a un producto inactivo ni las que no aportan nada.
  const quickReplies = visibleQuickReplies(allQuickReplies);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const slash = slashQuery(text, caret);
  // El GET ya viene por `position`; el selector muestra las primeras.
  const matches = slash
    ? matchQuickReplies(quickReplies, slash.query).slice(0, QUICK_REPLY_PICKER_MAX)
    : [];
  const pickerOpen =
    slash !== null && matches.length > 0 && dismissedAt !== slash.start;
  const active = Math.min(activeIndex, Math.max(matches.length - 1, 0));
  const activeReply = pickerOpen ? matches[active] : undefined;

  /** Texto de la respuesta con las variables ya resueltas para ESTE contacto. */
  function renderFor(reply: QuickReplyDto): string {
    return renderQuickReply(reply.body, {
      ...quickReplyContext(conversation.contact.name, viewer),
      producto: reply.product?.name ?? null,
    });
  }

  /**
   * 019 — Escenifica archivos del catálogo como chips: acumula sin duplicar
   * y respeta el tope de enviables. No convive con el adjunto suelto de 018
   * (son dos envíos distintos): con un archivo suelto elegido, avisa y no
   * agrega.
   */
  function stage(files: CatalogFileDto[]) {
    if (files.length === 0) return;
    if (file) {
      setError("Quita el adjunto para agregar archivos del catálogo");
      return;
    }
    setSummary(null);
    const r = stageFiles(staged, files, conversation.outboundFiles);
    setStaged(r.staged);
    if (r.overLimit > 0) {
      setError(
        `Máximo ${CATALOG_LIMITS.maxBatchFiles} archivos por envío: ${r.overLimit} no se agregaron`
      );
    }
  }

  /** "Insertar detalles": en la posición del cursor (o al final), en su renglón. */
  function insertDetails(snippet: string) {
    const at = Math.min(caret, text.length);
    const before = text.slice(0, at);
    const after = text.slice(at);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const trail = after && !after.startsWith("\n") ? "\n" : "";
    const next = insertQuickReply(text, at, at, lead + snippet + trail);
    setText(next.text);
    setCaret(next.caret - trail.length);
    setTimeout(autogrow, 0);
  }

  function closeCatalog() {
    setCatalogOpen(false);
    setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      autogrow();
    }, 0);
  }

  /** Reemplaza el `/atajo` por la respuesta; queda editable, nada se envía. */
  function pickQuickReply(reply: QuickReplyDto) {
    if (!slash) return;
    const next = insertQuickReply(text, slash.start, caret, renderFor(reply));
    setText(next.text);
    setCaret(next.caret);
    setDismissedAt(null);
    stage(quickReplyFiles(reply));
    setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      autogrow();
    }, 0);
  }

  /** Sigue el cursor: el selector depende de la palabra donde está. */
  function trackCaret(value: string, position: number) {
    const before = slashQuery(text, caret);
    const after = slashQuery(value, position);
    setCaret(position);
    if (!after || after.start !== before?.start) {
      setDismissedAt(null);
      setActiveIndex(0);
    } else if (after.query !== before.query) {
      setActiveIndex(0);
    }
    // Al abrir el selector se pide la lista otra vez: alguien pudo editarla
    // en Ajustes mientras esta Bandeja estaba abierta.
    if (after && !before) void reloadQuickReplies();
  }

  // 019: los chips son de ESTA conversación; al cambiar de hilo se descartan
  // (mandar fotos al cliente equivocado es peor que volver a elegirlas).
  useEffect(() => {
    setStaged([]);
    setSummary(null);
    setCatalogOpen(false);
  }, [conversation.id]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: TemplateDto[] }) => {
        if (!cancelled)
          setTemplates((d.templates ?? []).filter((t) => t.status === "approved"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // La URL del preview de imagen se libera al reemplazar/limpiar el archivo.
  useEffect(() => {
    return () => {
      if (filePreview) URL.revokeObjectURL(filePreview);
    };
  }, [filePreview]);

  function autogrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  async function pickFile(f: File | null) {
    // 018: validación LIGERA por extensión contra el `accept` del canal; el
    // servidor (firma del contenido) sigue siendo la autoridad.
    if (f && staged.length > 0) {
      setError("Quita los archivos del catálogo para adjuntar otro archivo");
      return;
    }
    const files = conversation.outboundFiles;
    const accept = clipAccept(files);
    if (f && files && accept && !extensionAllowed(f.name, accept)) {
      setError(files.hint);
      return;
    }
    // 019 (15-oct): WebP/GIF/HEIC → JPG y fotos sobre el tope de imagen del
    // canal → reducidas, en el navegador. Si no puede, queda el original con
    // un aviso y el servidor responde su 415/413 como siempre.
    let picked = f;
    let note: string | null = null;
    const maxBytes = imageMaxBytes(files);
    if (
      f &&
      maxBytes !== null &&
      planImageNormalization({ mimeType: f.type, fileName: f.name, size: f.size }, { maxBytes })
        .action === "convert"
    ) {
      setPreparing(true);
      setError(null);
      const r = await normalizeImageFile(f, { maxBytes });
      setPreparing(false);
      picked = r.file;
      const summary = normalizationSummary(r);
      note = [summary && `Imagen ${summary}`, r.note].filter(Boolean).join(" · ") || null;
    }
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFile(picked);
    setFileNote(note);
    setFilePreview(picked && PREVIEWABLE.test(picked.type) ? URL.createObjectURL(picked) : null);
    setPanel(null);
    setError(null);
  }

  async function apiSend(path: string, init: RequestInit): Promise<string | null> {
    const res = await fetch(path, init).catch(() => null);
    if (!res) return "Sin conexión con el servidor";
    if (res.ok) return null;
    if (res.status === 404 && onNotVisible) {
      // 09: otro vendedor la tomó; el envío no salió. La Bandeja cierra el
      // hilo y avisa.
      onNotVisible();
      return "Esta conversación ahora la atiende otro vendedor.";
    }
    const data = (await res.json().catch(() => null)) as {
      message?: string;
      error?: { message?: string };
    } | null;
    return data?.error?.message ?? data?.message ?? `Error ${res.status}`;
  }

  /**
   * 019 — Envío con chips del catálogo: un solo POST con el texto y los ids
   * compatibles en orden (FR-933). Espera al servidor (como el adjunto): el
   * botón queda deshabilitado mientras viaja.
   */
  async function submitCatalog() {
    if (sending) return;
    const value = text.trim();
    const { blocked } = splitStaged(staged, conversation.outboundFiles);
    const body = catalogBatchBody(value, staged, conversation.outboundFiles);
    if (!body) {
      setError(
        value
          ? "Ninguno de los archivos es compatible con este canal: quítalos para enviar solo el texto"
          : "Ninguno de los archivos es compatible con este canal: quítalos o escribe un texto"
      );
      return;
    }
    setSending(true);
    setSummary(null);
    const res = await fetch(`/api/conversations/${conversation.id}/messages/catalog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res
      ? ((await res.json().catch(() => null)) as
          | (CatalogBatchResult & { error?: { code?: string; message?: string } })
          | null)
      : null;
    setSending(false);
    if (!res) {
      setError("Sin conexión con el servidor");
      return;
    }
    if (!res.ok || !data || !Array.isArray(data.results)) {
      // El 404 de "conversación no visible" y el de "ningún archivo existe"
      // comparten código: se distinguen por el mensaje del route.
      if (
        res.status === 404 &&
        onNotVisible &&
        data?.error?.message === "Conversación no encontrada"
      ) {
        onNotVisible();
        setError("Esta conversación ahora la atiende otro vendedor.");
        return;
      }
      setError(data?.error?.message ?? `Error ${res.status}`);
      return;
    }
    setSummary(summarizeBatch(data, staged, blocked.length));
    setStaged(stagedAfterSend(staged, data));
    // El texto se limpia si salió (o no había); si el lote se cortó antes,
    // se conserva para reintentar.
    if (!body.text || data.text) {
      setText("");
      if (taRef.current) taRef.current.style.height = "auto";
    }
    onSent();
  }

  async function submit() {
    // Con una imagen convirtiéndose, Enter no debe mandar el pie como texto.
    if (preparing) return;
    setError(null);

    if (staged.length > 0) {
      await submitCatalog();
      return;
    }

    if (file) {
      // El adjunto sí espera: sube el archivo y no tiene sentido encolar otro
      // mientras tanto.
      if (sending) return;
      setSending(true);
      const form = new FormData();
      form.set("file", file);
      const caption = text.trim();
      if (caption) form.set("caption", caption);
      const err = await apiSend(
        `/api/conversations/${conversation.id}/messages/media`,
        { method: "POST", body: form }
      );
      setSending(false);
      if (err) {
        setError(err);
        return;
      }
      void pickFile(null);
      setText("");
      if (taRef.current) taRef.current.style.height = "auto";
      onSent();
      return;
    }

    const value = text.trim();
    if (!value) return;
    // Aquí NO se espera al servidor. Enviar tarda ~1.5 s (el viaje a Meta) y
    // durante ese rato el renglón siguiente se escribía encima del anterior y
    // salía todo como un solo mensaje. El campo se limpia ya; la burbuja
    // "enviando" del hilo es la que informa el estado real.
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    const err = await onSend(value);
    if (err) {
      setError(err);
      // Lo que no salió vuelve al campo. Si ya empezaste a escribir otra cosa
      // se antepone en vez de pisarte: nada se pierde en silencio.
      setText((actual) => (actual ? `${value}\n${actual}` : value));
      taRef.current?.focus();
      setTimeout(autogrow, 0);
    }
  }

  async function submitLocation() {
    const coords = parseCoords(coordsRaw);
    if (!coords) {
      setError("Coordenadas inválidas — pega «lat, long» o un enlace de Google Maps");
      return;
    }
    setSending(true);
    setError(null);
    const err = await apiSend(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "location",
        location: { ...coords, ...(placeName.trim() ? { name: placeName.trim() } : {}) },
      }),
    });
    setSending(false);
    if (err) {
      setError(err);
      return;
    }
    setPanel(null);
    setCoordsRaw("");
    setPlaceName("");
    onSent();
  }

  async function submitContact() {
    if (!contactName.trim() || contactPhone.trim().length < 5) {
      setError("El contacto necesita nombre y teléfono");
      return;
    }
    setSending(true);
    setError(null);
    const err = await apiSend(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "contacts",
        contacts: [{ name: contactName.trim(), phone: contactPhone.trim() }],
      }),
    });
    setSending(false);
    if (err) {
      setError(err);
      return;
    }
    setPanel(null);
    setContactName("");
    setContactPhone("");
    onSent();
  }

  // 017: con el canal cerrado no hay nada que escribir. Pasa en Instagram y
  // Messenger después de 7 días sin mensajes del cliente.
  if (conversation.replyMode === "closed") {
    return (
      <div className="border-t bg-background px-[18px] py-3.5">
        <div className="flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-3 text-sm text-warning-text">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.7} />
          <div>
            <p className="font-medium">No se puede retomar esta conversación.</p>
            <p className="opacity-80">
              Pasaron más de 7 días desde el último mensaje del cliente. Este
              canal no permite escribirle hasta que vuelva a escribir.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (conversation.replyMode === "template") {
    return (
      <div className="border-t bg-background px-[18px] py-3.5">
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-3 text-sm text-warning-text">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.7} />
          <div>
            <p className="font-medium">La ventana de 24 horas está cerrada.</p>
            <p className="opacity-80">
              WhatsApp solo permite texto libre dentro de las 24 horas
              siguientes al último mensaje del cliente. Para retomar la
              conversación, envía una plantilla aprobada.
            </p>
          </div>
        </div>
        <TemplateSender conversationId={conversation.id} onSent={onSent} />
      </div>
    );
  }

  const canSubmit =
    !preparing && (file !== null || staged.length > 0 || text.trim().length > 0);
  // 019: el botón Catálogo, como las respuestas rápidas, solo con texto libre.
  const canUseCatalog =
    conversation.replyMode === "free" || conversation.replyMode === "human_agent";

  return (
    <div className="border-t bg-background px-[18px] pb-3.5 pt-3">
      {/* 09: los chips son las primeras respuestas rápidas del catálogo (en
          cualquier canal); sin catálogo, como antes, las plantillas. */}
      {quickReplies.length > 0 && !file && panel === null && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {[...quickReplies]
            .sort((a, b) => a.position - b.position)
            .slice(0, 4)
            .map((r) => (
              <button
                key={r.id}
                className="rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-text-2 transition-colors hover:border-brand-soft hover:bg-brand-tint hover:text-brand-text"
                onClick={() => {
                  const value = renderFor(r);
                  setText(value);
                  setCaret(value.length);
                  stage(quickReplyFiles(r));
                  taRef.current?.focus();
                  setTimeout(autogrow, 0);
                }}
                title={r.body || r.title}
              >
                {r.title}
              </button>
            ))}
        </div>
      )}

      {quickReplies.length === 0 && conversation.templates && templates.length > 0 && !file && panel === null && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {templates.slice(0, 4).map((t) => (
            <button
              key={t.id}
              className="rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-text-2 transition-colors hover:border-brand-soft hover:bg-brand-tint hover:text-brand-text"
              onClick={() => {
                const firstName = conversation.contact.name.split(" ")[0] ?? "";
                setText(t.body.replace(/\{\{\s*1\s*\}\}/g, firstName));
                taRef.current?.focus();
                setTimeout(autogrow, 0);
              }}
              title={t.body}
            >
              {t.name.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      )}

      {file && (
        <div className="mb-2.5 flex items-center gap-2.5 rounded-md border bg-secondary/50 p-2.5">
          {filePreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={filePreview}
              alt={file.name}
              className="h-14 w-14 rounded object-cover"
            />
          ) : (
            <FileText className="h-8 w-8 shrink-0 text-brand" strokeWidth={1.5} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-text-3">
              {formatBytes(file.size)} · el texto de abajo va como pie del adjunto
            </p>
            <p className="text-[11px] text-text-4">
              Los archivos se eliminan del CRM a los 30 días.
            </p>
            {fileNote && (
              <p data-testid="attach-note" className="text-[11px] text-warning-text">
                {fileNote}
              </p>
            )}
          </div>
          <button
            onClick={() => void pickFile(null)}
            aria-label="Quitar adjunto"
            className="rounded p-1 text-text-3 hover:bg-secondary hover:text-text-1"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>
      )}

      {staged.length > 0 && (
        <div className="mb-2.5 rounded-md border bg-secondary/50 p-2">
          <ul className="flex flex-wrap gap-1.5" aria-label="Archivos del catálogo por enviar">
            {staged.map((f) => {
              const c = fileCompatibility(f, conversation.outboundFiles);
              return (
                <li
                  key={f.id}
                  data-testid="staged-file"
                  data-file-id={f.id}
                  data-compatible={c.ok ? "true" : "false"}
                  title={c.ok ? f.fileName : c.reason}
                  className={cn(
                    "flex max-w-[220px] items-center gap-1.5 rounded-md border bg-background py-1 pl-1 pr-0.5",
                    !c.ok && "opacity-50 grayscale"
                  )}
                >
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
                  <span className="min-w-0">
                    <span className="block truncate text-xs">{f.fileName}</span>
                    {!c.ok && (
                      <span className="block truncate text-[10.5px] text-text-3">
                        No compatible · no se envía
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => setStaged((prev) => prev.filter((x) => x.id !== f.id))}
                    aria-label={`Quitar ${f.fileName}`}
                    className="shrink-0 rounded p-0.5 text-text-3 hover:bg-secondary hover:text-text-1"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.7} />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[11px] text-text-3">
            El texto sale primero y después los archivos, en este orden.
          </p>
        </div>
      )}

      {panel === "location" && (
        <div className="mb-2.5 flex flex-wrap items-end gap-2 rounded-md border bg-secondary/50 p-2.5">
          <label className="min-w-0 flex-1 text-xs text-text-2">
            Coordenadas o enlace de Google Maps
            <input
              value={coordsRaw}
              onChange={(e) => setCoordsRaw(e.target.value)}
              placeholder="21.019, -101.257"
              className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </label>
          <label className="min-w-0 flex-1 text-xs text-text-2">
            Nombre del lugar (opcional)
            <input
              value={placeName}
              onChange={(e) => setPlaceName(e.target.value)}
              placeholder="Oficina AISHIA"
              className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </label>
          <button
            onClick={() => void submitLocation()}
            disabled={sending}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:bg-brand-hover disabled:opacity-40"
          >
            Enviar ubicación
          </button>
          <button
            onClick={() => setPanel(null)}
            aria-label="Cancelar"
            className="rounded p-1 text-text-3 hover:bg-secondary"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>
      )}

      {panel === "contact" && (
        <div className="mb-2.5 flex flex-wrap items-end gap-2 rounded-md border bg-secondary/50 p-2.5">
          <label className="min-w-0 flex-1 text-xs text-text-2">
            Nombre
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Xavier Pérez"
              className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </label>
          <label className="min-w-0 flex-1 text-xs text-text-2">
            Teléfono
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+52 462 123 4567"
              className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </label>
          <button
            onClick={() => void submitContact()}
            disabled={sending}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:bg-brand-hover disabled:opacity-40"
          >
            Enviar contacto
          </button>
          <button
            onClick={() => setPanel(null)}
            aria-label="Cancelar"
            className="rounded p-1 text-text-3 hover:bg-secondary"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-2 rounded-md border bg-background px-3 py-2 transition-shadow focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft">
        {pickerOpen && (
          <QuickReplyPicker
            matches={matches}
            activeIndex={active}
            onHover={setActiveIndex}
            onPick={pickQuickReply}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept={clipAccept(conversation.outboundFiles)}
          className="hidden"
          onChange={(e) => {
            void pickFile(e.target.files?.[0] ?? null);
            // Permite volver a elegir el mismo archivo tras quitarlo o tras
            // un rechazo.
            e.target.value = "";
          }}
        />
        {/* 018: el clip según `outboundFiles`; ubicación y contactos según
            `outboundStructured` (matriz por canal, FR-804). */}
        {(conversation.outboundFiles || conversation.outboundStructured) && (
          <div className="flex shrink-0 items-center gap-0.5">
            {conversation.outboundFiles && (
              <button
                onClick={() => fileRef.current?.click()}
                aria-label="Adjuntar archivo"
                disabled={staged.length > 0 || preparing}
                title={
                  staged.length > 0
                    ? "Quita los archivos del catálogo para adjuntar otro archivo"
                    : conversation.outboundFiles.hint
                }
                className="rounded p-1.5 text-text-3 transition-colors hover:bg-secondary hover:text-text-1"
              >
                <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.7} />
              </button>
            )}
            {conversation.outboundStructured && (
              <>
                <button
                  onClick={() => setPanel(panel === "location" ? null : "location")}
                  aria-label="Enviar ubicación"
                  title="Enviar ubicación"
                  className={cn(
                    "rounded p-1.5 text-text-3 transition-colors hover:bg-secondary hover:text-text-1",
                    panel === "location" && "bg-secondary text-brand"
                  )}
                >
                  <MapPin className="h-[18px] w-[18px]" strokeWidth={1.7} />
                </button>
                <button
                  onClick={() => setPanel(panel === "contact" ? null : "contact")}
                  aria-label="Compartir contacto"
                  title="Compartir contacto"
                  className={cn(
                    "rounded p-1.5 text-text-3 transition-colors hover:bg-secondary hover:text-text-1",
                    panel === "contact" && "bg-secondary text-brand"
                  )}
                >
                  <UserRound className="h-[18px] w-[18px]" strokeWidth={1.7} />
                </button>
              </>
            )}
          </div>
        )}
        {canUseCatalog && (
          <button
            onClick={() => {
              setCatalogOpen(true);
              void catalogState.load();
            }}
            disabled={file !== null}
            aria-label="Catálogo"
            title={
              file
                ? "Quita el adjunto para agregar archivos del catálogo"
                : "Catálogo de productos"
            }
            className="shrink-0 rounded p-1.5 text-text-3 transition-colors hover:bg-secondary hover:text-text-1 disabled:opacity-40"
          >
            <Package className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </button>
        )}
        <textarea
          ref={taRef}
          placeholder={file ? "Pie del adjunto (opcional)…" : "Escribe una respuesta…"}
          value={text}
          rows={1}
          aria-autocomplete="list"
          aria-controls={pickerOpen ? QUICK_REPLY_LISTBOX_ID : undefined}
          aria-activedescendant={
            activeReply ? quickReplyOptionId(activeReply.id) : undefined
          }
          onChange={(e) => {
            trackCaret(e.target.value, e.target.selectionStart);
            setText(e.target.value);
            autogrow();
          }}
          onSelect={(e) => {
            const position = e.currentTarget.selectionStart;
            if (position !== caret) trackCaret(text, position);
          }}
          onKeyDown={(e) => {
            // Con el selector abierto, las flechas, Enter/Tab y Esc son suyos:
            // Enter INSERTA la respuesta, no envía (RF-09-23).
            if (pickerOpen && slash) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((active + step + matches.length) % matches.length);
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                if (activeReply) pickQuickReply(activeReply);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(slash.start);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="max-h-[120px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-text-3"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || !canSubmit}
          aria-label="Enviar"
          className={cn(
            "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand text-brand-fg transition-opacity hover:bg-brand-hover",
            (sending || !canSubmit) && "opacity-40"
          )}
        >
          <Send className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <div className="min-w-0">
          {preparing && (
            <p role="status" data-testid="attach-preparing" className="text-xs text-text-2">
              Preparando la imagen…
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {summary && (
            <p role="status" className="text-xs text-text-2">
              {summary}
            </p>
          )}
        </div>
        <p className="text-[11px] text-text-3">
          {conversation.replyMode === "human_agent"
            ? "Fuera de las 24 h · tu respuesta sale como agente humano (hasta 7 días)"
            : `Ventana abierta · quedan ${formatRemaining(conversation.windowRemainingMs)}`}
        </p>
      </div>
      {catalogOpen && (
        <CatalogPanel
          catalog={catalogState.catalog}
          loading={catalogState.loading}
          error={catalogState.error}
          onRetry={() => void catalogState.load(true)}
          outboundFiles={conversation.outboundFiles}
          isOwner={viewer.role === "owner"}
          onAdd={(files) => {
            stage(files);
            closeCatalog();
          }}
          onInsertDetails={insertDetails}
          onClose={closeCatalog}
        />
      )}
    </div>
  );
}
