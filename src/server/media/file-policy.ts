import type { OutboundFileRule, OutboundFiles } from "@/lib/outbound-files";

/**
 * 018 — Política única de archivos (FR-801/802/803), para los TRES canales.
 *
 * El tipo de un archivo se decide por la firma de su contenido (magic bytes),
 * nunca por la extensión ni por el MIME que declara quien lo manda: ambos los
 * controla el remitente. Es una LISTA BLANCA: lo que no se reconoce como uno
 * de los tipos permitidos se bloquea, con una razón que se le muestra tal
 * cual al usuario.
 *
 * Sin dependencias: los ZIP de Office se revisan leyendo su directorio
 * central (los nombres de las entradas) SIN descomprimir nada. La detección
 * de JavaScript en PDF es de mejor esfuerzo (un PDF ofuscado puede pasar); lo
 * que de verdad protege al CRM es cómo se sirve el archivo (`serve.ts`).
 */

export type FileKind = "image" | "audio" | "video" | "document" | "sticker";

export type FileInspection =
  | {
      ok: true;
      /** MIME detectado por firma: el único que se guarda y se sirve. */
      mime: string;
      /**
       * Tipo de mensaje. Un webp es `image`: si es sticker lo decide quien
       * llama (WhatsApp lo dice en el mensaje, no en los bytes).
       */
      kind: FileKind;
      /** Extensión canónica, sin punto. */
      ext: string;
      /** ¿Se puede mostrar inline en el navegador? (imagen/audio/video). */
      inlineSafe: boolean;
    }
  | { ok: false; reason: string };

export type DeclaredFile = { fileName?: string | null; mime?: string | null };

/** Tope global de un archivo, antes de mirar el canal (FR-803). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const OOXML_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

const INLINE_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Razones de bloqueo (en español, para el usuario). */
const REASON = {
  empty: "El archivo está vacío",
  executable: "Archivo bloqueado por seguridad: es un programa ejecutable",
  script: "Archivo bloqueado por seguridad: es un guion ejecutable",
  archive:
    "Archivo bloqueado por seguridad: no se aceptan archivos comprimidos (zip, rar, 7z, gz)",
  oldOffice:
    "Formato antiguo de Office (.doc/.xls/.ppt) no permitido: guárdalo como .docx/.xlsx/.pptx",
  macros: "Archivo bloqueado por seguridad: el documento de Office contiene macros",
  pdfScript:
    "Archivo bloqueado por seguridad: el PDF contiene código (JavaScript o acciones automáticas)",
  markup: "Archivo bloqueado por seguridad: no se aceptan HTML, SVG ni XML",
  heic: "Imagen HEIC/AVIF no soportada: conviértela a JPG o PNG",
  text: "El archivo de texto no es UTF-8 válido",
  unknown:
    "Tipo de archivo no permitido: se aceptan imágenes, PDF, Word, Excel, PowerPoint, TXT, CSV, audio y video",
} as const;

function ok(mime: string, kind: FileKind, ext: string): FileInspection {
  return {
    ok: true,
    mime,
    kind,
    ext,
    inlineSafe:
      INLINE_IMAGES.has(mime) || mime.startsWith("audio/") || mime.startsWith("video/"),
  };
}

function blocked(reason: string): FileInspection {
  return { ok: false, reason };
}

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (b[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < Math.min(end, b.length); i++) s += String.fromCharCode(b[i]!);
  return s;
}

const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0));

function declaredExt(fileName?: string | null): string {
  const name = (fileName ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

function declaredMime(mime?: string | null): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

/* ---------- ZIP (sin descomprimir) ---------- */

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/**
 * Nombres de las entradas, leídos del directorio central (End of Central
 * Directory → registros `PK\x01\x02`). null = ZIP ilegible o ZIP64.
 */
export function zipEntryNames(b: Uint8Array): string[] | null {
  const EOCD = [0x50, 0x4b, 0x05, 0x06];
  const minStart = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = b.length - 22; i >= minStart; i--) {
    if (startsWith(b, EOCD, i)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  // ZIP64: los campos de 16/32 bits vienen saturados. Un Office de oficina no
  // llega ahí; se trata como ilegible.
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
  if (cdOffset + cdSize > b.length) return null;

  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || !startsWith(b, [0x50, 0x4b, 0x01, 0x02], p)) return null;
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    if (p + 46 + nameLen > b.length) return null;
    names.push(decoder.decode(b.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const MACRO_EXTS = new Set(["docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppsm", "ppam"]);

function inspectZip(b: Uint8Array, ext: string): FileInspection {
  const names = zipEntryNames(b);
  if (!names) return blocked(REASON.archive);
  const lower = names.map((n) => n.toLowerCase());
  if (!lower.includes("[content_types].xml")) return blocked(REASON.archive);
  if (lower.some((n) => n.endsWith("vbaproject.bin")) || MACRO_EXTS.has(ext)) {
    return blocked(REASON.macros);
  }
  if (lower.some((n) => n.startsWith("word/"))) return ok(OOXML_MIME.docx, "document", "docx");
  if (lower.some((n) => n.startsWith("xl/"))) return ok(OOXML_MIME.xlsx, "document", "xlsx");
  if (lower.some((n) => n.startsWith("ppt/"))) return ok(OOXML_MIME.pptx, "document", "pptx");
  // Otro paquete OPC (xps, nupkg, vsdx…): fuera de la lista blanca.
  return blocked(REASON.unknown);
}

/* ---------- PDF ---------- */

/** Nombres PDF que ejecutan algo al abrir. Mejor esfuerzo: no ve lo ofuscado. */
const PDF_ACTIVE = /\/(JavaScript|Launch)\b|\/JS[\s(<[]/;

function inspectPdf(b: Uint8Array): FileInspection {
  const raw = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
  if (PDF_ACTIVE.test(raw)) return blocked(REASON.pdfScript);
  return ok("application/pdf", "document", "pdf");
}

/* ---------- ISO-BMFF (mp4/m4a/3gp/mov) ---------- */

function inspectIsoBmff(b: Uint8Array, declared: string): FileInspection {
  const brand = ascii(b, 8, 12);
  if (/^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) return blocked(REASON.heic);
  if (brand.startsWith("M4A") || brand.startsWith("M4B") || declared.startsWith("audio/")) {
    return ok("audio/mp4", "audio", "m4a");
  }
  if (brand.startsWith("3gp") || brand.startsWith("3g2")) return ok("video/3gpp", "video", "3gp");
  if (brand === "qt  ") return ok("video/quicktime", "video", "mov");
  return ok("video/mp4", "video", "mp4");
}

/* ---------- Texto ---------- */

const MARKUP_START = /^(<!doctype|<html|<svg|<\?xml|<script)/i;
const MARKUP_EXTS = new Set(["html", "htm", "xhtml", "svg", "xml", "xsl", "hta", "mht"]);

function inspectText(b: Uint8Array, ext: string, mime: string): FileInspection {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return blocked(REASON.text);
  }
  if (text.includes("\u0000")) return blocked(REASON.text);
  if (MARKUP_START.test(text.replace(/^﻿/, "").trimStart())) return blocked(REASON.markup);

  const isCsv = ext === "csv" || (ext !== "txt" && mime === "text/csv");
  const isTxt = ext === "txt" || (ext !== "csv" && mime === "text/plain");
  if (isCsv) return ok("text/csv", "document", "csv");
  if (isTxt) return ok("text/plain", "document", "txt");
  if (MARKUP_EXTS.has(ext) || /html|svg|xml/.test(mime)) return blocked(REASON.markup);
  return blocked(REASON.unknown);
}

/* ---------- Entrada única ---------- */

/**
 * Decide el tipo REAL de un archivo por su contenido. `declared` (nombre y
 * MIME del remitente) solo desempata lo que los bytes no dicen: texto
 * (.txt/.csv), audio MPEG sin cabecera ID3 y m4a vs mp4.
 */
export function inspectFile(bytes: Uint8Array, declared: DeclaredFile = {}): FileInspection {
  const b = bytes;
  const ext = declaredExt(declared.fileName);
  const mime = declaredMime(declared.mime);
  if (b.length === 0) return blocked(REASON.empty);

  // Imágenes.
  if (startsWith(b, [0xff, 0xd8, 0xff])) return ok("image/jpeg", "image", "jpg");
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ok("image/png", "image", "png");
  }
  if (startsWith(b, bytesOf("GIF87a")) || startsWith(b, bytesOf("GIF89a"))) {
    return ok("image/gif", "image", "gif");
  }
  if (startsWith(b, bytesOf("RIFF"))) {
    const form = ascii(b, 8, 12);
    if (form === "WEBP") return ok("image/webp", "image", "webp");
    if (form === "WAVE") return ok("audio/wav", "audio", "wav");
    return blocked(REASON.unknown);
  }

  // Documentos.
  if (startsWith(b, bytesOf("%PDF-"))) return inspectPdf(b);
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    return inspectZip(b, ext);
  }
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return blocked(REASON.oldOffice);
  }

  // Ejecutables, guiones y comprimidos.
  if (startsWith(b, bytesOf("MZ"))) return blocked(REASON.executable);
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return blocked(REASON.executable);
  if (startsWith(b, bytesOf("#!AMR"))) return ok("audio/amr", "audio", "amr");
  if (startsWith(b, bytesOf("#!"))) return blocked(REASON.script);
  if (startsWith(b, bytesOf("Rar!\x1a\x07"))) return blocked(REASON.archive);
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return blocked(REASON.archive);
  if (startsWith(b, [0x1f, 0x8b])) return blocked(REASON.archive);

  // Audio y video.
  if (startsWith(b, bytesOf("OggS"))) return ok("audio/ogg", "audio", "ogg");
  if (startsWith(b, bytesOf("ID3"))) return ok("audio/mpeg", "audio", "mp3");
  if (startsWith(b, bytesOf("ftyp"), 4)) return inspectIsoBmff(b, mime);
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return mime.startsWith("audio/")
      ? ok("audio/webm", "audio", "webm")
      : ok("video/webm", "video", "webm");
  }
  // Frame sync MPEG (11 bits a 1). Es una firma floja —muchos binarios
  // empiezan con 0xFF—, así que solo cuenta si el remitente dijo "audio".
  const audioHint =
    mime.startsWith("audio/") || ext === "mp3" || ext === "aac" || ext === "m4a";
  if (audioHint && b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    if ((b[1]! & 0xf6) === 0xf0) return ok("audio/aac", "audio", "aac"); // ADTS
    if (((b[1]! >> 1) & 0x03) !== 0) return ok("audio/mpeg", "audio", "mp3");
  }

  // Sin firma binaria conocida: solo puede ser texto (o markup, bloqueado).
  return inspectText(b, ext, mime);
}

/* ---------- Validación de salida (FR-803) ---------- */

export class MediaValidationError extends Error {
  code: "too_large" | "unsupported_type";
  constructor(code: MediaValidationError["code"], message: string) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

export type OutboundCheck = {
  inspection: Extract<FileInspection, { ok: true }>;
  rule: OutboundFileRule;
  /** MIME con el que se entrega a la plataforma (puede diferir del detectado). */
  sendMime: string;
};

/** Paso 1 del envío: tope global y firma/lista blanca. Lanza MediaValidationError. */
export function inspectOutgoing(
  data: Uint8Array,
  declared: DeclaredFile
): Extract<FileInspection, { ok: true }> {
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new MediaValidationError(
      "too_large",
      `El archivo excede el tope de ${MAX_FILE_BYTES / (1024 * 1024)} MB`
    );
  }
  const inspection = inspectFile(data, declared);
  if (!inspection.ok) throw new MediaValidationError("unsupported_type", inspection.reason);
  return inspection;
}

/**
 * Paso 2 del envío: la matriz del canal. Tipo no permitido → 415 con la frase
 * del canal; tamaño → 413 con el límite de la regla. `files` null = el canal
 * no manda archivos.
 */
export function checkChannelFile(
  files: OutboundFiles | null,
  inspection: Extract<FileInspection, { ok: true }>,
  sizeBytes: number,
  channelLabel: string
): OutboundCheck {
  if (!files) {
    throw new MediaValidationError(
      "unsupported_type",
      `${channelLabel} no permite enviar archivos desde el CRM`
    );
  }
  const rule = files.rules.find((r) => r.mimes.includes(inspection.mime));
  if (!rule) throw new MediaValidationError("unsupported_type", files.hint);
  if (sizeBytes > rule.maxBytes) {
    throw new MediaValidationError(
      "too_large",
      `El archivo excede el límite de ${rule.label} en ${channelLabel}`
    );
  }
  return {
    inspection,
    rule,
    sendMime: files.sendMimeAs?.[inspection.mime] ?? inspection.mime,
  };
}
