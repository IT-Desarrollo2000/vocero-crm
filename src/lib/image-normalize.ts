/**
 * 019 (ampliación 15-oct) — Imágenes convertidas y reducidas EN EL NAVEGADOR.
 *
 * WhatsApp e Instagram solo envían imágenes JPG/PNG (en WhatsApp el WebP es
 * solo sticker) y el servidor sigue aceptando únicamente JPG/PNG por firma
 * (`src/server/media/file-policy.ts`). Para que una foto WebP/GIF/HEIC o una
 * foto de teléfono demasiado pesada no termine en un 415/413, el navegador la
 * re-codifica a JPEG antes de subirla. Nada de dependencias nativas.
 *
 * Módulo de cliente SIN imports de servidor. `planImageNormalization` es pura
 * (testeable en Node); `normalizeImageFile` toca `canvas`/`createImageBitmap`
 * solo dentro de la función, nunca al cargar el módulo.
 */

export type ImageNormalizationInput = {
  mimeType: string;
  fileName: string;
  size: number;
};

export type ImageNormalizationPlan =
  | { action: "keep" }
  | { action: "convert"; reason: "format" | "size"; outputName: string };

export type NormalizedImage = {
  file: File;
  converted: boolean;
  /** Por qué se re-codificó (solo si `converted`). */
  reason?: "format" | "size";
  /** Aviso legible: formato no decodificable, primer fotograma de un GIF… */
  note?: string;
};

/** Para ampliar un `accept`: lo que el navegador convierte a JPG. */
export const CONVERTIBLE_IMAGE_ACCEPT =
  ".webp,.gif,.heic,.heif,image/webp,image/gif,image/heic,image/heif";

export const UNDECODABLE_NOTE =
  "Tu navegador no puede convertir este formato; súbela como JPG o PNG";

const GIF_NOTE = "Si era un GIF animado, solo se conserva el primer fotograma";

/** Lado mayor tras la conversión. */
export const NORMALIZE_MAX_DIMENSION = 2560;
/** Margen bajo el tope: el resultado queda ≤ 98 % de `maxBytes`. */
const SIZE_MARGIN = 0.98;
/** Calidades a probar a la dimensión inicial antes de empezar a escalar. */
const QUALITY_STEPS = [0.85, 0.75, 0.65] as const;
const SCALE_STEP = 0.8;
/** Intentos de codificación en total (calidades + escalados). */
const MAX_ATTEMPTS = 10;
const MIN_DIMENSION = 64;

const KEEP_MIMES = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png"]);
const KEEP_EXT = new Set(["jpg", "jpeg", "jpe", "png"]);
const CONVERT_MIMES = new Set([
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "image/bmp",
  "image/x-ms-bmp",
  "image/avif",
]);
const CONVERT_EXT = new Set(["webp", "gif", "heic", "heif", "bmp", "avif"]);
/** MIME que no dicen nada: se decide por la extensión. */
const OPAQUE_MIMES = new Set(["", "application/octet-stream"]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** `foto.webp` → `foto.jpg`; sin extensión se añade; vacío → `imagen.jpg`. */
export function jpegName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  if (!base) return "imagen.jpg";
  const dot = base.lastIndexOf(".");
  return `${dot > 0 ? base.slice(0, dot) : base}.jpg`;
}

type Family = "keep" | "convert" | "other";

function familyOf(mimeType: string, fileName: string): Family {
  const mime = mimeType.trim().toLowerCase();
  if (!OPAQUE_MIMES.has(mime)) {
    if (KEEP_MIMES.has(mime)) return "keep";
    if (CONVERT_MIMES.has(mime)) return "convert";
    return "other";
  }
  const ext = extensionOf(fileName);
  if (KEEP_EXT.has(ext)) return "keep";
  if (CONVERT_EXT.has(ext)) return "convert";
  return "other";
}

/**
 * Qué hacer con un archivo antes de subirlo: JPG/PNG dentro del tope se queda;
 * JPG/PNG pesado se re-codifica (`size`); WebP/GIF/HEIC/HEIF/BMP/AVIF pasa a
 * JPEG (`format`); lo que no es imagen convertible (PDF, Office, audio…) se
 * queda tal cual.
 */
export function planImageNormalization(
  input: ImageNormalizationInput,
  opts: { maxBytes: number }
): ImageNormalizationPlan {
  const family = familyOf(input.mimeType, input.fileName);
  if (family === "other") return { action: "keep" };
  if (family === "convert") {
    return { action: "convert", reason: "format", outputName: jpegName(input.fileName) };
  }
  if (input.size <= opts.maxBytes) return { action: "keep" };
  return { action: "convert", reason: "size", outputName: jpegName(input.fileName) };
}

/** `5 MB`, `4.7 MB`, `820 KB` — para avisos. */
export function formatImageSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number(mb.toFixed(1))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "convertida a JPG (1.2 MB)" / "reducida a 4.7 MB"; null si no se tocó. */
export function normalizationSummary(result: NormalizedImage): string | null {
  if (!result.converted) return null;
  const size = formatImageSize(result.file.size);
  return result.reason === "size" ? `reducida a ${size}` : `convertida a JPG (${size})`;
}

/* ------------------------------ navegador ------------------------------ */

type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

async function decodeImage(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      // `from-image`: respeta la orientación EXIF de las fotos de teléfono.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (bmp.width > 0 && bmp.height > 0) {
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      }
      bmp.close();
    } catch {
      // Cae al <img>: algunos navegadores decodifican ahí lo que el bitmap no.
    }
  }
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      URL.revokeObjectURL(url);
      return null;
    }
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function encodeJpeg(
  img: Decoded,
  width: number,
  height: number,
  quality: number
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) return Promise.resolve(null);
  // Fondo BLANCO: la transparencia de un PNG/WebP saldría negra en JPEG.
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, width, height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img.source, 0, 0, width, height);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        // Libera la memoria del lienzo (fotos grandes en teléfonos).
        canvas.width = 0;
        canvas.height = 0;
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

/**
 * Re-codifica a JPEG hasta quedar ≤ 98 % de `maxBytes`: lado mayor a 2560 px
 * con calidad 0.85 → 0.75 → 0.65, y luego escala ×0.8 (a 0.65) hasta caber,
 * con un máximo de 10 intentos. null si no cabe ni así.
 */
async function encodeWithin(img: Decoded, maxBytes: number): Promise<Blob | null> {
  const target = Math.floor(maxBytes * SIZE_MARGIN);
  const fit = Math.min(1, NORMALIZE_MAX_DIMENSION / Math.max(img.width, img.height));
  let scale = fit;
  let attempts = 0;
  const tryAt = async (quality: number) => {
    attempts++;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const blob = await encodeJpeg(img, w, h, quality);
    return blob && blob.size <= target ? blob : null;
  };
  for (const q of QUALITY_STEPS) {
    const blob = await tryAt(q);
    if (blob) return blob;
  }
  const lastQuality = QUALITY_STEPS[QUALITY_STEPS.length - 1] ?? 0.65;
  while (attempts < MAX_ATTEMPTS) {
    scale *= SCALE_STEP;
    if (Math.max(img.width, img.height) * scale < MIN_DIMENSION) break;
    const blob = await tryAt(lastQuality);
    if (blob) return blob;
  }
  return null;
}

/**
 * Normaliza un archivo antes de subirlo según `planImageNormalization`. Si el
 * navegador no puede decodificarlo (p. ej. HEIC en Chrome) o no logra bajarlo
 * del tope, devuelve el ORIGINAL con `converted:false` y un aviso: el servidor
 * lo rechazará con su 415/413 como siempre. Nunca lanza.
 */
export async function normalizeImageFile(
  file: File,
  opts: { maxBytes: number }
): Promise<NormalizedImage> {
  const plan = planImageNormalization(
    { mimeType: file.type, fileName: file.name, size: file.size },
    opts
  );
  if (plan.action === "keep") return { file, converted: false };
  if (typeof document === "undefined") return { file, converted: false, note: UNDECODABLE_NOTE };

  const decoded = await decodeImage(file).catch(() => null);
  if (!decoded) return { file, converted: false, note: UNDECODABLE_NOTE };
  try {
    const blob = await encodeWithin(decoded, opts.maxBytes).catch(() => null);
    if (!blob) {
      return {
        file,
        converted: false,
        note: `No se pudo reducir la imagen por debajo de ${formatImageSize(opts.maxBytes)}`,
      };
    }
    const out = new File([blob], plan.outputName, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
    const isGif =
      file.type.toLowerCase() === "image/gif" || extensionOf(file.name) === "gif";
    return {
      file: out,
      converted: true,
      reason: plan.reason,
      ...(isGif ? { note: GIF_NOTE } : {}),
    };
  } finally {
    decoded.close();
  }
}
