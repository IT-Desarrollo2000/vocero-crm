import { faviconBadgeDot } from "@/lib/alerts";

/**
 * Punto de "pendientes" sobre el favicon de la marca (RF-05-08, D-05-3).
 *
 * Toma el `href` actual de cada `<link rel="icon">` (el white-label, subido o
 * generado, mismo origen → no contamina el canvas), lo dibuja en 64×64 con
 * un punto rojo de borde blanco y cambia el `href` por el data URL. El
 * original se guarda en `data-vocero-original` para restaurarlo con N = 0.
 * Cualquier error (no carga, formato raro) → el favicon NO se toca: jamás un
 * icono roto; el título sigue mostrando `(N)`.
 *
 * Sin dependencias de React y con el DOM inyectable, para probarlo en node.
 */

export const ORIGINAL_ATTR = "data-vocero-original";
const SIZE = 64;

export type IconLinkLike = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export type IconDocLike = {
  querySelectorAll(selector: string): ArrayLike<IconLinkLike>;
};

/** Dibuja `src` con el punto y devuelve un data URL, o `null` si no se pudo. */
export type BadgeRenderer = (src: string) => Promise<string | null>;

function iconLinks(doc: IconDocLike): IconLinkLike[] {
  return Array.from(doc.querySelectorAll('link[rel~="icon"]'));
}

export function createFaviconBadge(
  doc: IconDocLike,
  render: BadgeRenderer = renderWithCanvas
) {
  const cache = new Map<string, string>();
  let generation = 0;

  const restore = () => {
    generation += 1;
    for (const link of iconLinks(doc)) {
      const original = link.getAttribute(ORIGINAL_ATTR);
      if (original === null) continue;
      link.setAttribute("href", original);
      link.removeAttribute(ORIGINAL_ATTR);
    }
  };

  const show = async () => {
    const gen = ++generation;
    for (const link of iconLinks(doc)) {
      const original = link.getAttribute(ORIGINAL_ATTR) ?? link.getAttribute("href");
      if (!original) continue;
      let badged = cache.get(original) ?? null;
      if (!badged) {
        badged = await render(original).catch(() => null);
        if (!badged) continue; // no dibujable: se deja como está
        cache.set(original, badged);
      }
      // Un `set(false)` posterior ganó la carrera: no re-poner el punto.
      if (gen !== generation) return;
      link.setAttribute(ORIGINAL_ATTR, original);
      link.setAttribute("href", badged);
    }
  };

  return {
    /** `true` = con punto; `false` = icono original. */
    set(on: boolean): Promise<void> {
      if (!on) {
        restore();
        return Promise.resolve();
      }
      return show();
    },
    restore,
  };
}

/** `href` del icono de la marca SIN el punto (icono de las notificaciones). */
export function brandIconHref(doc: IconDocLike): string | undefined {
  const link = iconLinks(doc)[0];
  if (!link) return undefined;
  return link.getAttribute(ORIGINAL_ATTR) ?? link.getAttribute("href") ?? undefined;
}

/** Renderer real: `Image` + canvas 64×64. */
export async function renderWithCanvas(src: string): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  try {
    const img = new Image();
    img.decoding = "async";
    const loaded = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(true);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    img.src = src;
    if (!(await loaded)) return null;

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0, SIZE, SIZE);
    const dot = faviconBadgeDot(SIZE);
    g.beginPath();
    g.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2);
    g.fillStyle = dot.fill;
    g.fill();
    g.lineWidth = dot.ring * 2;
    g.strokeStyle = dot.stroke;
    g.stroke();
    return canvas.toDataURL("image/png");
  } catch {
    // Canvas contaminado u otro fallo: favicon intacto.
    return null;
  }
}
