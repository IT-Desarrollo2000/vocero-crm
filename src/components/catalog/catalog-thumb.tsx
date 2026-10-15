"use client";

import { useState } from "react";
import { ImageOff, Package } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Miniatura del catálogo. Si la imagen no carga (storage caído, archivo
 * borrado) se cambia por un marcador: una miniatura rota nunca rompe la
 * página (spec 019, escenario 7).
 */
export function CatalogThumb({
  src,
  alt,
  className,
}: {
  /** undefined = el producto no tiene imágenes. */
  src: string | undefined;
  alt: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    const Icon = src ? ImageOff : Package;
    return (
      <div
        className={cn("flex items-center justify-center bg-secondary text-text-3", className)}
        aria-label={src ? `${alt} (no se pudo cargar)` : undefined}
        role={src ? "img" : undefined}
        data-broken={src ? "true" : undefined}
      >
        <Icon className="h-6 w-6" strokeWidth={1.5} aria-hidden />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn("bg-secondary object-cover", className)}
    />
  );
}
