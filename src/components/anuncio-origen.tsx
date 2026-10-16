"use client";

import { useState } from "react";
import { ExternalLink, Megaphone } from "lucide-react";
import type { AnuncioDto } from "@/lib/types";
import { etiquetaDeOrigen, titularDeOrigen } from "@/lib/anuncios";

/**
 * 020 — De qué anuncio llegó esta persona (adaptado de upstream 018,
 * `src/components/anuncio-origen.tsx`).
 *
 * La misma tarjeta en la Bandeja (panel del contacto) y en el cajón del trato
 * del pipeline: la pregunta "¿quién la trajo?" se hace en los dos sitios. Va
 * entera o no va: una conversación orgánica no enseña un hueco vacío.
 *
 * Solo lo que Meta manda en el `referral`: el nombre del anuncio, la campaña o
 * el conjunto no vienen ahí, y pedirlos exigiría la API de Marketing.
 */
export function AnuncioOrigen({ anuncio }: { anuncio: AnuncioDto }) {
  // La imagen puede no estar (caducó antes de copiarse, host no permitido) o
  // dejar de servirse: la tarjeta sigue diciendo lo importante sin ella.
  const [imagenRota, setImagenRota] = useState(false);
  const etiqueta = etiquetaDeOrigen(anuncio.sourceType);
  const titular = titularDeOrigen(anuncio.headline, anuncio.sourceType);
  const fecha = new Date(anuncio.capturedAt).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      className="rounded-md border border-info-soft bg-info-tint px-3 py-2.5"
      data-anuncio-origen={anuncio.sourceId ?? ""}
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-info-text">
        <Megaphone className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        {etiqueta === "Anuncio" ? "Llegó por un anuncio" : "Llegó por una publicación"}
      </p>

      <div className="mt-2 flex items-start gap-2.5">
        {anuncio.imageUrl && !imagenRota && (
          // eslint-disable-next-line @next/next/no-img-element -- adjunto privado servido con sesión; no hay host que optimizar
          <img
            src={anuncio.imageUrl}
            alt={`Miniatura: ${titular}`}
            loading="lazy"
            onError={() => setImagenRota(true)}
            className="h-14 w-14 shrink-0 rounded border border-info-soft bg-background object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] font-semibold leading-snug text-foreground">
            {titular}
          </p>
          {anuncio.body && (
            <p className="mt-0.5 line-clamp-3 break-words text-xs text-text-2">
              {anuncio.body}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 space-y-0.5 text-[11px] text-text-3">
        <p>
          Primer mensaje · {fecha}
          {anuncio.mediaType === "video" ? " · con video" : ""}
        </p>
        {anuncio.sourceId && (
          <p className="truncate font-mono" title={anuncio.sourceId}>
            ID {anuncio.sourceId}
          </p>
        )}
        {/* Solo la presencia, y solo en una instancia que atribuye: el valor
            del identificador de clic no sale del servidor. */}
        {anuncio.hasCtwaClid && <p>Meta identificó el clic</p>}
      </div>

      {anuncio.sourceUrl?.startsWith("https://") && (
        <a
          href={anuncio.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-text underline underline-offset-2 hover:text-brand"
        >
          Ver {etiqueta.toLowerCase()}
          <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
        </a>
      )}
    </div>
  );
}

/**
 * 020 — Etiqueta compacta de la fila de la Bandeja: "Anuncio · <titular>"
 * ("Publicación · …" si `source_type=post`). Trunca: el titular completo va en
 * el `title` y en la tarjeta del panel.
 */
export function EtiquetaDeOrigen({
  anuncio,
}: {
  anuncio: { headline: string | null; sourceType: string | null };
}) {
  const texto = `${etiquetaDeOrigen(anuncio.sourceType)} · ${titularDeOrigen(
    anuncio.headline,
    anuncio.sourceType
  )}`;
  return (
    <span
      data-testid="origin-chip"
      title={texto}
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-info-soft bg-info-tint px-2 py-0.5 text-[11px] text-info-text"
    >
      <Megaphone className="h-3 w-3 shrink-0" strokeWidth={1.7} />
      <span className="truncate">{texto}</span>
    </span>
  );
}

/**
 * 020 fase B — Miniatura compacta del anuncio (tabla de Reportes → Anuncios).
 * Sin imagen, o si deja de servirse, un icono en su lugar: la fila no salta.
 */
export function MiniaturaDeAnuncio({
  src,
  titular,
  className,
}: {
  src: string | null;
  titular: string;
  className?: string;
}) {
  const [rota, setRota] = useState(false);
  const base = `shrink-0 rounded border border-info-soft bg-info-tint ${className ?? "h-10 w-10"}`;
  if (!src || rota) {
    return (
      <span aria-hidden="true" className={`${base} flex items-center justify-center text-info-text`}>
        <Megaphone className="h-4 w-4" strokeWidth={1.7} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- adjunto privado servido con sesión; no hay host que optimizar
    <img
      src={src}
      alt={`Miniatura: ${titular}`}
      loading="lazy"
      onError={() => setRota(true)}
      className={`${base} object-cover`}
    />
  );
}
