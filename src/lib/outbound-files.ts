/**
 * 018 — Qué archivos acepta un canal de salida (matriz FR-804).
 *
 * Vive en `lib/` porque viaja en el DTO de la conversación hasta el
 * compositor: tiene que ser JSON puro (sin RegExp ni funciones). La política
 * que DECIDE el tipo real de un archivo está en `src/server/media/file-policy.ts`;
 * esto solo declara qué tipos detectados deja pasar cada canal y con qué tope.
 */

/** Tipo de mensaje con el que sale un archivo. */
export type OutboundFileKind = "image" | "audio" | "video" | "document";

export type OutboundFileRule = {
  kind: OutboundFileKind;
  /** MIME DETECTADOS (por firma) que entran en esta regla. */
  mimes: string[];
  /** Tope en bytes para esta regla en este canal. */
  maxBytes: number;
  /** Etiqueta legible para el mensaje de "excede el límite". */
  label: string;
};

export type OutboundFiles = {
  rules: OutboundFileRule[];
  /** Valor del atributo `accept` del `<input type="file">`. */
  accept: string;
  /** Qué acepta el canal, en una frase (rechazo 415 y ayuda del compositor). */
  hint: string;
  /**
   * MIME con el que se ENTREGA un tipo detectado a la plataforma, cuando no
   * coincide con el detectado. WhatsApp no acepta `text/csv`: sale como
   * `text/plain` conservando el nombre `.csv`.
   */
  sendMimeAs?: Record<string, string>;
};

const MB = 1024 * 1024;

const IMAGE_MIMES = ["image/jpeg", "image/png"];
const OFFICE_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
];
const IMAGE_EXT = ".jpg,.jpeg,.png";
const OFFICE_EXT = ".pdf,.docx,.xlsx,.pptx,.txt,.csv";

/** WhatsApp Cloud API: límites de la plataforma por tipo. */
export const WHATSAPP_OUTBOUND_FILES: OutboundFiles = {
  rules: [
    { kind: "image", mimes: IMAGE_MIMES, maxBytes: 5 * MB, label: "imagen (JPG/PNG, máx. 5 MB)" },
    { kind: "document", mimes: OFFICE_MIMES, maxBytes: 100 * MB, label: "documento (máx. 100 MB)" },
    {
      kind: "audio",
      mimes: ["audio/ogg", "audio/mpeg", "audio/aac", "audio/amr", "audio/mp4"],
      maxBytes: 16 * MB,
      label: "audio (máx. 16 MB)",
    },
    {
      kind: "video",
      mimes: ["video/mp4", "video/3gpp"],
      maxBytes: 16 * MB,
      label: "video (MP4/3GP, máx. 16 MB)",
    },
  ],
  accept: `${IMAGE_EXT},${OFFICE_EXT},.ogg,.opus,.mp3,.aac,.amr,.m4a,.mp4,.3gp`,
  hint: "WhatsApp acepta imágenes JPG/PNG, PDF, Word, Excel, PowerPoint, TXT, CSV, audio y video MP4/3GP",
  sendMimeAs: { "text/csv": "text/plain" },
};

/** Messenger (Send API con `filedata`): 25 MB para todo. */
export const MESSENGER_OUTBOUND_FILES: OutboundFiles = {
  rules: [
    { kind: "image", mimes: IMAGE_MIMES, maxBytes: 25 * MB, label: "imagen (JPG/PNG, máx. 25 MB)" },
    { kind: "document", mimes: OFFICE_MIMES, maxBytes: 25 * MB, label: "documento (máx. 25 MB)" },
    {
      kind: "audio",
      mimes: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav"],
      maxBytes: 25 * MB,
      label: "audio (máx. 25 MB)",
    },
    {
      kind: "video",
      mimes: ["video/mp4", "video/quicktime", "video/3gpp"],
      maxBytes: 25 * MB,
      label: "video (máx. 25 MB)",
    },
  ],
  accept: `${IMAGE_EXT},${OFFICE_EXT},.mp3,.m4a,.aac,.ogg,.wav,.mp4,.mov,.3gp`,
  hint: "Messenger acepta imágenes JPG/PNG, PDF, Word, Excel, PowerPoint, TXT, CSV, audio y video",
};

/**
 * Instagram con login de Instagram (Meta): imagen png/jpeg 8 MB y, como
 * archivo, SOLO PDF (25 MB). Sin audio ni video saliente (fuera de alcance).
 */
export const INSTAGRAM_OUTBOUND_FILES: OutboundFiles = {
  rules: [
    { kind: "image", mimes: IMAGE_MIMES, maxBytes: 8 * MB, label: "imagen (JPG/PNG, máx. 8 MB)" },
    { kind: "document", mimes: ["application/pdf"], maxBytes: 25 * MB, label: "PDF (máx. 25 MB)" },
  ],
  accept: `${IMAGE_EXT},.pdf`,
  hint: "Instagram solo acepta imágenes (JPG/PNG) y PDF",
};
