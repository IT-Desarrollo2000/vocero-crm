"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Play, X } from "lucide-react";
import {
  formatDuration,
  formatSizeMb,
  trainingFileUrl,
  type TrainingAssetDto,
} from "@/lib/training";
import { cn } from "@/lib/utils";

/**
 * 034 — El material de capacitación dentro de la Ayuda (diseño aprobado
 * `specs/034-ayuda-material/diseno/`): el recuadro «Capacitación del equipo»
 * (PDF para descargar + videos en orden), el diálogo que reproduce un video
 * con anterior/siguiente, y el selector «Imagen | Video» de cada tema.
 *
 * Los archivos los sirve `GET /api/training/[id]/file` (con sesión, `Range`
 * para el video): nada sale de `public/`.
 */

/** Frase bajo el título del recuadro, según lo que haya subido. */
export function trainingBoxIntro(
  docs: number,
  videos: TrainingAssetDto[],
  topicTitles: Record<string, string>
): string {
  const parts: string[] = [];
  if (docs > 0) parts.push(docs === 1 ? "El documento para descargar" : "Los documentos para descargar");
  if (videos.length > 0) {
    const v =
      videos.length === 1 ? "el video completo" : `los ${videos.length} videos completos, en orden`;
    parts.push(parts.length ? v : v.charAt(0).toUpperCase() + v.slice(1));
  }
  let text = `${parts.join(" y ")}.`;
  const withTopic = videos.filter((v) => v.topicId && topicTitles[v.topicId]).length;
  if (withTopic > 0 && withTopic === videos.length) {
    text +=
      videos.length === 1
        ? " También aparece en su tema de la guía."
        : " Cada video también aparece en su tema de la guía.";
  } else if (withTopic > 0) {
    text += " Los que tienen tema también aparecen en la guía.";
  }
  return text;
}

export function TrainingBox({
  documents,
  videos,
  topicTitles,
}: {
  documents: TrainingAssetDto[];
  videos: TrainingAssetDto[];
  /** Temas VISIBLES en esta instancia → su título (enlace «En la guía»). */
  topicTitles: Record<string, string>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    // El foco vuelve al botón que abrió el video.
    requestAnimationFrame(() => opener.current?.focus());
  }, []);

  return (
    <section
      aria-labelledby="capacitacion-titulo"
      data-testid="training-box"
      className="space-y-3.5 rounded-lg border border-brand-soft bg-brand-tint px-4 py-4 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-[1_1_300px] space-y-0.5">
          <h2 id="capacitacion-titulo" className="text-base font-semibold text-foreground">
            Capacitación del equipo
          </h2>
          <p className="text-[13.5px] leading-snug text-text-2">
            {trainingBoxIntro(documents.length, videos, topicTitles)}
          </p>
        </div>
        {documents.map((d, i) => (
          <a
            key={d.id}
            href={trainingFileUrl(d.id)}
            download
            data-testid="training-doc"
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-md px-3.5 py-2.5 text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              i === 0
                ? "bg-brand text-brand-fg hover:bg-brand-hover"
                : "border border-brand-soft bg-card text-foreground hover:bg-accent"
            )}
          >
            <Download aria-hidden className="h-4 w-4 shrink-0" strokeWidth={2} />
            {d.title} (PDF · {formatSizeMb(d.sizeBytes)})
          </a>
        ))}
      </div>
      {videos.length > 0 && (
        <ol aria-label="Videos de capacitación" className="flex flex-wrap gap-2">
          {videos.map((v, i) => (
            <li key={v.id}>
              <button
                type="button"
                data-testid="training-video-chip"
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setOpen(i);
                }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-brand-soft bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Play aria-hidden className="h-3 w-3 shrink-0 fill-brand text-brand" />
                {i + 1} · {v.title}
                {formatDuration(v.durationSeconds) && (
                  <span className="text-text-2">{formatDuration(v.durationSeconds)}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      {/* En `document.body`: como hijo de esta sección, `space-y-3.5` le
          daba `margin-top` al velo `fixed` y dejaba 14 px sin cubrir. */}
      {open !== null &&
        videos[open] &&
        createPortal(
          <TrainingVideoDialog
            videos={videos}
            index={open}
            topicTitles={topicTitles}
            onIndex={setOpen}
            onClose={close}
          />,
          document.body
        )}
    </section>
  );
}

export function TrainingVideoDialog({
  videos,
  index,
  topicTitles,
  onIndex,
  onClose,
}: {
  videos: TrainingAssetDto[];
  index: number;
  topicTitles: Record<string, string>;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const video = videos[index]!;
  const prev = index > 0 ? videos[index - 1] : null;
  const next = index < videos.length - 1 ? videos[index + 1] : null;
  const topicTitle = video.topicId ? topicTitles[video.topicId] : undefined;
  const duration = formatDuration(video.durationSeconds);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Foco atrapado: Tab no se sale del diálogo.
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), video[controls]'
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="training-video-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="training-video-dialog"
        className="flex max-h-full w-full max-w-[920px] flex-col overflow-hidden rounded-lg bg-card shadow-pop"
      >
        <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-xs text-text-2">
              Video {index + 1} de {videos.length}
              {duration ? ` · ${duration}` : ""}
            </p>
            <h2 id={titleId} className="truncate text-[17px] font-semibold text-foreground">
              {video.title}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Cerrar video"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border-strong bg-card text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        <div className="aspect-video min-h-0 bg-video">
          {/* key: al cambiar de video se monta otro <video> (empieza de cero). */}
          <video
            key={video.id}
            src={trainingFileUrl(video.id)}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="h-full w-full"
            aria-label={video.title}
          />
        </div>

        <footer className="flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:px-5">
          {topicTitle ? (
            <a
              href={`#${video.topicId}`}
              onClick={onClose}
              className="min-w-0 flex-[1_1_260px] rounded text-[13.5px] font-medium text-brand-text underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              En la guía: «{topicTitle}»
            </a>
          ) : (
            <span className="flex-[1_1_260px]" />
          )}
          {prev && (
            <button
              type="button"
              onClick={() => onIndex(index - 1)}
              className="min-h-11 rounded-md border border-border-strong bg-card px-3.5 py-2 text-[13.5px] text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ‹ {index} · {prev.title}
            </button>
          )}
          {next && (
            <button
              type="button"
              onClick={() => onIndex(index + 1)}
              className="min-h-11 rounded-md bg-brand px-3.5 py-2 text-[13.5px] font-semibold text-brand-fg transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {index + 2} · {next.title} ›
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * Figura de un tema con video: «Imagen | Video · m:ss». Arranca en Video
 * (como el diseño); «Imagen» regresa a la captura de siempre. Sin imagen
 * (capturas que no existen), solo el video y sin pestañas.
 */
export function TopicMedia({
  topicId,
  video,
  imagePanel,
}: {
  topicId: string;
  video: TrainingAssetDto;
  imagePanel: React.ReactNode | null;
}) {
  const [tab, setTab] = useState<"image" | "video">("video");
  const base = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  // Pasar a «Imagen» pausa el video: oculto, seguiría sonando.
  useEffect(() => {
    if (tab === "image") videoRef.current?.pause();
  }, [tab]);
  const duration = formatDuration(video.durationSeconds);
  const player = (
    <div className="aspect-video overflow-hidden rounded-lg bg-video">
      <video
        ref={videoRef}
        src={trainingFileUrl(video.id)}
        controls
        playsInline
        preload="metadata"
        className="h-full w-full"
        aria-label={video.title}
        data-testid="topic-video"
      />
    </div>
  );
  if (!imagePanel) return <div className="space-y-2">{player}</div>;

  const tabs = [
    { key: "image" as const, label: "Imagen" },
    { key: "video" as const, label: `Video${duration ? ` · ${duration}` : ""}` },
  ];
  return (
    <div className="space-y-2.5" data-testid="topic-media" data-topic={topicId}>
      <div
        role="tablist"
        aria-label="Ver como"
        className="inline-flex gap-[3px] rounded-md border border-border-strong bg-secondary p-[3px]"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const nextTab = tab === "image" ? "video" : "image";
          setTab(nextTab);
          document.getElementById(`${base}-${nextTab}-tab`)?.focus();
        }}
      >
        {tabs.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              id={`${base}-${t.key}-tab`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${base}-${t.key}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex min-h-9 items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-card font-semibold text-foreground shadow-sm"
                  : "text-text-2 hover:text-foreground"
              )}
            >
              {t.key === "video" && (
                <Play aria-hidden className="h-3 w-3 shrink-0 fill-brand text-brand" />
              )}
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${base}-video-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-video-tab`}
        hidden={tab !== "video"}
      >
        {player}
      </div>
      <div
        id={`${base}-image-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-image-tab`}
        hidden={tab !== "image"}
      >
        {imagePanel}
      </div>
    </div>
  );
}
