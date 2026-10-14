"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Clock3,
  Download,
  FileSpreadsheet,
  FileText,
  FileX,
  Loader2,
  MapPin,
  Paperclip,
  Presentation,
  ShieldAlert,
  Smartphone,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { MessageDto, MessageMediaDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatBytes, mediaLabel } from "./helpers";

function StatusTicks({ status }: { status: MessageDto["status"] }) {
  const cls = "h-[13px] w-[13px]";
  if (status === "pending") return <Clock3 className={cn(cls, "text-text-4")} strokeWidth={1.7} />;
  if (status === "sent") return <Check className={cn(cls, "text-text-4")} strokeWidth={1.7} />;
  if (status === "delivered")
    return <CheckCheck className={cn(cls, "text-text-4")} strokeWidth={1.7} />;
  if (status === "read")
    return <CheckCheck className={cn(cls, "text-[#53bdeb]")} strokeWidth={1.7} />;
  return <AlertTriangle className={cn(cls, "text-destructive")} strokeWidth={1.7} />;
}

type LocationPayload = {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
};

type ContactPayload = {
  name?: { formatted_name?: string; first_name?: string } | string;
  phones?: { phone?: string }[];
  phone?: string;
};

/** 008 — Previsualización del adjunto de un mensaje, por tipo. */
function MediaBlock({ media }: { media: MessageMediaDto }) {
  const src = `/api/media/${media.assetId}`;

  if (media.kind === "location") {
    const loc = (media.payload ?? {}) as LocationPayload;
    const coords =
      typeof loc.latitude === "number" && typeof loc.longitude === "number"
        ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`
        : null;
    return (
      <span className="flex items-start gap-1.5">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.7} />
        <span className="min-w-0">
          <span className="block font-medium">{loc.name ?? "Ubicación"}</span>
          {loc.address && (
            <span className="block text-[12.5px] text-text-3">{loc.address}</span>
          )}
          {coords && (
            <a
              className="text-[12.5px] text-brand underline-offset-2 hover:underline"
              href={`https://maps.google.com/?q=${loc.latitude},${loc.longitude}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {coords} — abrir mapa
            </a>
          )}
        </span>
      </span>
    );
  }

  if (media.kind === "contacts") {
    const list = Array.isArray(media.payload)
      ? (media.payload as ContactPayload[])
      : [];
    return (
      <span className="flex flex-col gap-1">
        {list.length ? (
          list.map((c, i) => {
            const name =
              typeof c.name === "string"
                ? c.name
                : c.name?.formatted_name ?? c.name?.first_name ?? "Contacto";
            const phone = c.phones?.[0]?.phone ?? c.phone ?? null;
            return (
              <span key={i} className="flex items-center gap-1.5">
                <UserRound className="h-4 w-4 shrink-0 text-brand" strokeWidth={1.7} />
                <span>
                  <span className="block font-medium">{name}</span>
                  {phone && (
                    <span className="block text-[12.5px] text-text-3">{phone}</span>
                  )}
                </span>
              </span>
            );
          })
        ) : (
          <span className="text-text-3">Contacto compartido</span>
        )}
      </span>
    );
  }

  // 018: estados sin binario que abrir. Ninguno lleva enlace: un archivo
  // bloqueado no se puede abrir desde el CRM, uno expirado ya no existe.
  if (media.fetchStatus === "blocked") {
    return (
      <MediaNotice tone="danger" icon={ShieldAlert} testId="media-blocked">
        <span className="block font-medium">Archivo bloqueado por seguridad</span>
        {media.blockedReason && (
          <span className="block text-[12px] opacity-80">{media.blockedReason}</span>
        )}
      </MediaNotice>
    );
  }
  if (media.fetchStatus === "expired") {
    return (
      <MediaNotice icon={FileX} testId="media-expired">
        <span className="block font-medium">
          {media.fileName ?? mediaLabel(media.kind)}
        </span>
        <span className="block text-[12px]">
          Archivo eliminado — los archivos se guardan 30 días
        </span>
      </MediaNotice>
    );
  }
  if (media.fetchStatus === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-text-3" data-testid="media-pending">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.7} />
        {mediaLabel(media.kind)} — descargando…
      </span>
    );
  }
  if (media.fetchStatus === "failed") {
    return (
      <MediaNotice icon={Paperclip} testId="media-failed">
        <span className="block font-medium">{mediaLabel(media.kind)}</span>
        <span className="block text-[12px]">
          No disponible (expiró en la plataforma)
        </span>
      </MediaNotice>
    );
  }

  if (media.kind === "image" || media.kind === "sticker") {
    return <InlineImage src={src} alt={media.caption ?? mediaLabel(media.kind)} />;
  }
  if (media.kind === "video" || media.kind === "audio") {
    return <InlinePlayer src={src} kind={media.kind} mimeType={media.mimeType} />;
  }
  // document
  const DocIcon = documentIcon(media.mimeType, media.fileName);
  return (
    <a
      className="flex min-w-[200px] max-w-full items-center gap-2.5 rounded-md border bg-background/60 px-2.5 py-2 hover:bg-background"
      href={src}
      download={media.fileName ?? ""}
      rel="noreferrer noopener"
      data-testid="media-document"
    >
      <DocIcon className="h-7 w-7 shrink-0 text-brand" strokeWidth={1.5} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {media.fileName ?? "Documento"}
        </span>
        <span className="block text-[12px] text-text-3">
          {[documentLabel(media.mimeType, media.fileName), media.fileSize != null ? formatBytes(media.fileSize) : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.7} />
    </a>
  );
}

/** 018 — Aviso en lugar del adjunto (bloqueado, expirado, no disponible). */
function MediaNotice({
  icon: Icon,
  tone = "muted",
  testId,
  children,
}: {
  icon: typeof Paperclip;
  tone?: "muted" | "danger";
  testId: string;
  children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-2",
        tone === "danger"
          ? "border-danger-soft bg-danger-tint text-danger-text"
          : "bg-background/60 text-text-3"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.7} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Imagen inline; si no carga, un aviso en vez del icono roto. */
function InlineImage({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <MediaNotice icon={AlertTriangle} testId="media-load-error">
        No se pudo cargar la imagen
      </MediaNotice>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer noopener" title="Ver completa">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-72 max-w-full rounded-md object-contain"
        loading="lazy"
        onError={() => setBroken(true)}
        data-testid="media-image"
      />
    </a>
  );
}

/** Audio o video con su reproductor; si no carga, un aviso. */
function InlinePlayer({
  src,
  kind,
  mimeType,
}: {
  src: string;
  kind: "audio" | "video";
  mimeType: string | null;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <MediaNotice icon={AlertTriangle} testId="media-load-error">
        No se pudo cargar el {kind === "audio" ? "audio" : "video"}
      </MediaNotice>
    );
  }
  if (kind === "audio") {
    return (
      <audio
        controls
        preload="metadata"
        src={src}
        className="max-w-full"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <video
      controls
      preload="metadata"
      src={src}
      className="max-h-72 max-w-full rounded-md"
      onError={() => setBroken(true)}
    >
      {mimeType && <source src={src} type={mimeType} />}
    </video>
  );
}

function extOf(fileName: string | null): string {
  const name = (fileName ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/** Icono de la tarjeta de documento según su tipo. */
function documentIcon(mime: string | null, fileName: string | null): typeof FileText {
  const m = mime ?? "";
  const ext = extOf(fileName);
  if (m.includes("spreadsheetml") || m === "text/csv" || ext === "xlsx" || ext === "csv")
    return FileSpreadsheet;
  if (m.includes("presentationml") || ext === "pptx") return Presentation;
  return FileText;
}

/** Tipo legible del documento (PDF, Word…). */
function documentLabel(mime: string | null, fileName: string | null): string | null {
  const m = mime ?? "";
  const ext = extOf(fileName);
  if (m === "application/pdf" || ext === "pdf") return "PDF";
  if (m.includes("wordprocessingml") || ext === "docx") return "Word";
  if (m.includes("spreadsheetml") || ext === "xlsx") return "Excel";
  if (m.includes("presentationml") || ext === "pptx") return "PowerPoint";
  if (m === "text/csv" || ext === "csv") return "CSV";
  if (m === "text/plain" || ext === "txt") return "Texto";
  return null;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
}

function bubbleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 018: cada cuánto se vuelve a pedir el hilo mientras un adjunto descarga. */
const PENDING_MEDIA_RETRY_MS = 3000;
/** Y cuántas veces como máximo (una descarga atascada no consulta para siempre). */
const PENDING_MEDIA_MAX_RETRIES = 10;

export function MessageThread({
  messages,
  onPendingMedia,
}: {
  messages: MessageDto[];
  /**
   * 018: la descarga de un adjunto entrante va en segundo plano y no emite
   * evento propio; mientras haya alguno en `pending`, el hilo pide un
   * refetch suave para que pase a disponible sin recargar.
   */
  onPendingMedia?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const retries = useRef(0);
  // En ref: el padre pasa una función nueva en cada render y no debe
  // reiniciar la espera.
  const onPendingRef = useRef(onPendingMedia);
  onPendingRef.current = onPendingMedia;
  const hasPending = messages.some((m) => m.media?.fetchStatus === "pending");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!hasPending) {
      retries.current = 0;
      return;
    }
    if (!onPendingRef.current || retries.current >= PENDING_MEDIA_MAX_RETRIES) return;
    const t = setTimeout(() => {
      retries.current++;
      onPendingRef.current?.();
    }, PENDING_MEDIA_RETRY_MS);
    return () => clearTimeout(t);
  }, [hasPending, messages]);

  return (
    <div
      ref={scrollRef}
      className="flex flex-1 flex-col gap-[3px] overflow-y-auto bg-chat px-3 py-5 sm:px-[6%]"
    >
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay =
          !prev ||
          new Date(prev.createdAt).toDateString() !==
            new Date(m.createdAt).toDateString();
        const grouped =
          !newDay && prev !== undefined && prev.direction === m.direction;
        const out = m.direction === "out";

        return (
          <div key={m.id}>
            {newDay && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full border bg-background px-3 py-1 text-[11.5px] font-semibold text-text-2 shadow-sm">
                  {dayLabel(m.createdAt)}
                </span>
              </div>
            )}
            <div
              className={cn(
                "flex",
                out ? "justify-end" : "justify-start",
                grouped ? "mt-[3px]" : "mt-2.5"
              )}
            >
              <div
                className={cn(
                  // En el teléfono la burbuja necesita casi todo el renglón:
                  // con 64% cada mensaje se parte en tres líneas.
                  "max-w-[85%] rounded-lg px-3 pb-1.5 pt-2 text-sm leading-[1.45] shadow-sm sm:max-w-[64%]",
                  out
                    ? "border border-brand-soft bg-bubble-out text-bubble-out-text"
                    : "bg-background",
                  !grouped && (out ? "rounded-tr-[5px]" : "rounded-tl-[5px]")
                )}
              >
                {m.media ? (
                  <span className="block">
                    <MediaBlock media={m.media} />
                    {m.media.caption && (
                      <span className="mt-1 block whitespace-pre-wrap break-words">
                        {m.media.caption}
                      </span>
                    )}
                  </span>
                ) : m.type === "text" || m.type === "template" ? (
                  <span className="whitespace-pre-wrap break-words">
                    {m.text}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-text-3">
                    <Paperclip className="h-3.5 w-3.5" strokeWidth={1.7} />
                    {mediaLabel(m.type)}
                    {m.text ? ` — ${m.text}` : ""}
                  </span>
                )}
                <span className="float-right ml-2 mt-1 flex items-center gap-1">
                  {m.aiGenerated && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[10px] font-medium text-brand"
                      title="Respuesta generada por IA"
                    >
                      <Sparkles className="h-3 w-3" strokeWidth={1.7} /> IA
                    </span>
                  )}
                  {m.origin === "manual" && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[10px] font-medium text-text-3"
                      title="Enviado a mano desde la app de WhatsApp Business"
                    >
                      <Smartphone className="h-3 w-3" strokeWidth={1.7} /> Celular
                    </span>
                  )}
                  <span className="text-[10.5px] text-text-4">
                    {bubbleTime(m.createdAt)}
                  </span>
                  {out && <StatusTicks status={m.status} />}
                </span>
                {out && m.status === "failed" && (
                  // El triángulo solo decía "algo falló". El motivo lo manda
                  // Meta y lo guardábamos sin enseñarlo nunca.
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-danger-soft bg-danger-tint px-2 py-1.5 text-[11.5px] leading-snug text-danger-text">
                    <AlertTriangle
                      className="mt-[1px] h-3.5 w-3.5 shrink-0"
                      strokeWidth={1.8}
                    />
                    <span>
                      <span className="font-semibold">No se entregó.</span>{" "}
                      {m.error ?? "Meta no informó el motivo."}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
