import type { Channel } from "@/lib/channels";
import { CHANNEL_LABEL } from "@/lib/channels";
import { cn } from "@/lib/utils";

/**
 * 014 — Distintivo de bandeja.
 *
 * Se dibuja como el ícono de la aplicación (mosaico de color con el glifo en
 * blanco) y no como un texto "WA"/"IG": el ícono se reconoce de un vistazo
 * mientras se recorre la lista, la sigla hay que leerla.
 *
 * Solo aparece cuando la instancia tiene más de un canal encendido. Con un
 * solo canal no hay nada que distinguir, y marcar cada renglón con el mismo
 * sello sería ruido — la misma razón por la que un canal apagado no tiene
 * pantalla ni webhook (ADR-001).
 *
 * Los trazos son las marcas oficiales de simple-icons (CC0).
 */

const WHATSAPP_PATH =
  "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z";

const INSTAGRAM_PATH =
  "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z";

const MESSENGER_PATH =
  "M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 00-.64.05l-2.39 1.05a.96.96 0 01-1.35-.85l-.07-2.14a.97.97 0 00-.32-.68A11.39 11.389 0 01.002 11.64zm8.32-2.19l-3.52 5.6c-.35.53.32 1.139.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 00-2.61.48z";

const MARK: Record<Channel, { path: string; tile: string }> = {
  whatsapp: { path: WHATSAPP_PATH, tile: "bg-[#25d366]" },
  instagram: {
    path: INSTAGRAM_PATH,
    tile: "bg-gradient-to-tr from-[#f9ce34] via-[#ee2a7b] to-[#6228d7]",
  },
  messenger: {
    path: MESSENGER_PATH,
    tile: "bg-gradient-to-tr from-[#0099ff] via-[#a033ff] to-[#ff5280]",
  },
};

/**
 * La marca de un canal, o null si no la tiene. Separada del componente para
 * poder afirmar en una prueba que TODO canal del catalogo tiene glifo: sin
 * eso, agregar un canal y olvidar su dibujo no rompe nada — el distintivo
 * simplemente no aparece y la bandeja se ve como si no tuviera canal.
 */
export function channelMark(channel: Channel) {
  return MARK[channel] ?? null;
}

export function ChannelBadge({
  channel,
  className,
}: {
  channel: Channel;
  /** Para ajustar el tamaño del mosaico donde haga falta (encabezados). */
  className?: string;
}) {
  // Un canal desconocido (fila vieja, dato ajeno) no debe tumbar la bandeja.
  const mark = channelMark(channel);
  if (!mark) return null;
  const label = CHANNEL_LABEL[channel] ?? channel;

  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4.5px]",
        mark.tile,
        className
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-[10px] w-[10px] fill-white"
      >
        <path d={mark.path} />
      </svg>
    </span>
  );
}
