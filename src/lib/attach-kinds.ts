/**
 * 031 — Menú «Adjuntar»: qué tipos de archivo deja mandar ESTE canal, con
 * sus formatos y su tope, ANTES de elegir el archivo. Sale de las reglas del
 * canal (`src/lib/outbound-files.ts`), nunca de textos fijos. Puro: lo usa
 * `attach-menu.tsx` y lo cubre `tests/unit/attach-kinds.test.ts`.
 */

import type { OutboundFileKind, OutboundFiles } from "@/lib/outbound-files";

const MB = 1024 * 1024;

/** Nombre corto y extensiones de cada MIME que puede detectar la política. */
const MIME_INFO: Record<string, { label: string; ext: string[] }> = {
  "image/jpeg": { label: "JPG", ext: [".jpg", ".jpeg"] },
  "image/png": { label: "PNG", ext: [".png"] },
  "application/pdf": { label: "PDF", ext: [".pdf"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    label: "Word",
    ext: [".docx"],
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    label: "Excel",
    ext: [".xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    label: "PowerPoint",
    ext: [".pptx"],
  },
  "text/plain": { label: "TXT", ext: [".txt"] },
  "text/csv": { label: "CSV", ext: [".csv"] },
  "audio/mpeg": { label: "MP3", ext: [".mp3"] },
  "audio/ogg": { label: "OGG", ext: [".ogg", ".opus"] },
  "audio/aac": { label: "AAC", ext: [".aac"] },
  "audio/amr": { label: "AMR", ext: [".amr"] },
  "audio/mp4": { label: "M4A", ext: [".m4a"] },
  "audio/wav": { label: "WAV", ext: [".wav"] },
  "video/mp4": { label: "MP4", ext: [".mp4"] },
  "video/3gpp": { label: "3GP", ext: [".3gp"] },
  "video/quicktime": { label: "MOV", ext: [".mov"] },
  "video/webm": { label: "WEBM", ext: [".webm"] },
};

const KIND_LABEL: Record<OutboundFileKind, string> = {
  image: "Foto",
  document: "Documento",
  video: "Video",
  audio: "Audio",
};

/** Orden del menú (el del diseño aprobado). */
const KIND_ORDER: OutboundFileKind[] = ["image", "document", "video", "audio"];

export type AttachKind = {
  kind: OutboundFileKind;
  /** «Foto», «Documento»… */
  label: string;
  /** «JPG o PNG», «PDF, Word, Excel o PowerPoint»… */
  formats: string;
  maxMb: number;
  /** `accept` del selector de archivos filtrado a este tipo. */
  accept: string;
};

/** «A», «A o B», «A, B o C». */
export function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} o ${items[items.length - 1]}`;
}

/** Tipos que el canal permite, con formatos, tope y `accept` por tipo. */
export function attachKinds(
  files: OutboundFiles | null | undefined,
  opts: { extraImageAccept?: string } = {}
): AttachKind[] {
  if (!files) return [];
  const channelExt = new Set(
    files.accept
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.startsWith("."))
  );
  return KIND_ORDER.flatMap((kind): AttachKind[] => {
    const rule = files.rules.find((r) => r.kind === kind);
    if (!rule) return [];
    const labels: string[] = [];
    const ext: string[] = [];
    for (const mime of rule.mimes) {
      const info = MIME_INFO[mime];
      if (!info) continue;
      const allowed = info.ext.filter((e) => channelExt.has(e));
      if (allowed.length === 0) continue;
      if (!labels.includes(info.label)) labels.push(info.label);
      for (const e of allowed) if (!ext.includes(e)) ext.push(e);
    }
    if (ext.length === 0) return [];
    const accept =
      kind === "image" && opts.extraImageAccept
        ? `${ext.join(",")},${opts.extraImageAccept}`
        : ext.join(",");
    return [
      {
        kind,
        label: KIND_LABEL[kind],
        formats: joinOr(labels),
        maxMb: Math.round(rule.maxBytes / MB),
        accept,
      },
    ];
  });
}

/**
 * ¿Mostrar el pie «¿Un .doc o .xls antiguo?…»? Solo si el canal acepta
 * documentos de Office modernos (en Instagram, solo PDF, no aplica).
 */
export function acceptsOfficeDocs(files: OutboundFiles | null | undefined): boolean {
  const doc = files?.rules.find((r) => r.kind === "document");
  return !!doc?.mimes.some((m) => m.startsWith("application/vnd.openxmlformats-officedocument"));
}
