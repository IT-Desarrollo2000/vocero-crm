/**
 * 034 — Material de capacitación de la Ayuda: contrato compartido por
 * servidor (rutas, store, servir por rangos) y cliente (Ayuda y Ajustes ›
 * Material de capacitación). Puro y sin imports de servidor: nada de
 * `Buffer`, `fs` ni `file-policy.ts` (los MIME detectados se replican aquí).
 *
 * El material es de CADA negocio y no va al repo (que es público): vive en el
 * almacenamiento de la instancia y lo sirve `GET /api/training/[id]/file`.
 */

import { z } from "zod";
import { HELP_TOPICS } from "./help/topics";

/* ------------------------------------------------------------------ *
 * Tipos y límites
 * ------------------------------------------------------------------ */

export const TRAINING_KINDS = ["document", "video", "help_image"] as const;
export type TrainingKind = (typeof TRAINING_KINDS)[number];

const MB = 1024 * 1024;

/**
 * Lo que admite cada tipo. El MIME es el DETECTADO por firma
 * (`inspectFile`), nunca el que declara el navegador. 100 MB de video caben en
 * un solo Put Blob de Azure (API 2021-08-06: hasta 5000 MiB).
 */
export const TRAINING_RULES: Record<
  TrainingKind,
  { maxBytes: number; mimes: readonly string[]; accept: string; label: string }
> = {
  document: {
    maxBytes: 25 * MB,
    mimes: ["application/pdf"],
    accept: ".pdf,application/pdf",
    label: "PDF de hasta 25 MB",
  },
  video: {
    maxBytes: 100 * MB,
    mimes: ["video/mp4"],
    accept: ".mp4,video/mp4",
    label: "MP4 de hasta 100 MB",
  },
  help_image: {
    maxBytes: 5 * MB,
    mimes: ["image/png", "image/jpeg", "image/webp"],
    accept: ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp",
    label: "PNG, JPG o WebP de hasta 5 MB",
  },
};

/** El mayor de los topes: el corte temprano por `content-length`. */
export const TRAINING_MAX_BYTES = Math.max(
  ...TRAINING_KINDS.map((k) => TRAINING_RULES[k].maxBytes)
);

export const TRAINING_LIMITS = {
  titleMax: 120,
  /** Por tipo: más de esto ya no es una Ayuda, es una videoteca. */
  maxPerKind: 50,
  /** 10 h: cualquier duración mayor es un dato roto del navegador. */
  durationMax: 36_000,
  dimensionMax: 20_000,
} as const;

/** Lo que ve la Ayuda y Ajustes. Sin `storage_key` ni `storage_provider`. */
export type TrainingAssetDto = {
  id: string;
  kind: TrainingKind;
  title: string;
  topicId: string | null;
  position: number;
  sizeBytes: number;
  durationSeconds: number | null;
  mimeType: string;
  /** Solo en imágenes (`help_image`), y null si el navegador no lo supo. */
  width?: number | null;
  height?: number | null;
};

export function trainingFileUrl(id: string): string {
  return `/api/training/${encodeURIComponent(id)}/file`;
}

/* ------------------------------------------------------------------ *
 * Validación (Zod)
 * ------------------------------------------------------------------ */

/** Ids de los temas de la guía (`HELP_TOPICS`): los únicos `topic_id` válidos. */
export const HELP_TOPIC_IDS = HELP_TOPICS.map((t) => t.id) as [string, ...string[]];

export const trainingTopicIdSchema = z.enum(HELP_TOPIC_IDS, {
  errorMap: () => ({ message: "El tema no existe en la Ayuda" }),
});

const titleSchema = z.string().trim().min(1).max(TRAINING_LIMITS.titleMax);

/** Un campo del multipart: "" o ausente = no vino. */
function formValue<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (v === null || v === undefined || v === "" ? undefined : v),
    schema.optional()
  );
}

const formInt = (min: number, max: number) =>
  formValue(z.coerce.number().int().min(min).max(max));

/**
 * Campos de `POST /api/training` (multipart, además de `file`). `topicId` es
 * obligatorio en una imagen de tema; en un video, sin él = «Ninguno: solo en
 * la lista de videos». `replaceId` = Reemplazar/Cambiar: la fila nueva hereda
 * título, tema y lugar de la vieja, que se borra.
 */
export const trainingUploadSchema = z
  .object({
    kind: z.enum(TRAINING_KINDS, {
      errorMap: () => ({ message: "Tipo de material inválido" }),
    }),
    title: formValue(titleSchema),
    topicId: formValue(trainingTopicIdSchema),
    durationSeconds: formInt(0, TRAINING_LIMITS.durationMax),
    width: formInt(1, TRAINING_LIMITS.dimensionMax),
    height: formInt(1, TRAINING_LIMITS.dimensionMax),
    replaceId: formValue(z.string().regex(/^[\w.-]{1,64}$/)),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "help_image" && !v.topicId && !v.replaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topicId"],
        message: "Una imagen de la Ayuda necesita su tema",
      });
    }
    if (v.kind === "document" && v.topicId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topicId"],
        message: "Un documento no va en un tema",
      });
    }
  });
export type TrainingUploadFields = z.infer<typeof trainingUploadSchema>;

/** `PATCH /api/training/[id]`: título y (en videos) tema; `null` = Ninguno. */
export const trainingPatchSchema = z
  .object({
    title: titleSchema.optional(),
    topicId: trainingTopicIdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.topicId !== undefined, {
    message: "Manda al menos un campo",
  });
export type TrainingPatchBody = z.infer<typeof trainingPatchSchema>;

/** `POST /api/training/reorder`: el orden COMPLETO de documentos o de videos. */
export const trainingReorderSchema = z
  .object({
    kind: z.enum(["document", "video"]),
    ids: z.array(z.string().min(1).max(64)).min(1).max(TRAINING_LIMITS.maxPerKind),
  })
  .strict()
  .refine((v) => new Set(v.ids).size === v.ids.length, {
    message: "Hay ids repetidos",
    path: ["ids"],
  });
export type TrainingReorderBody = z.infer<typeof trainingReorderSchema>;

/* ------------------------------------------------------------------ *
 * Formato
 * ------------------------------------------------------------------ */

/** `97` → `1:37`. null/negativo → null (se muestra sin duración). */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `3_565_158` → `3.4 MB` (una decimal, como en el diseño; mínimo 0.1). */
export function formatSizeMb(bytes: number): string {
  const mb = Math.max(0.1, Math.round((bytes / MB) * 10) / 10);
  return `${mb.toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * Range (RFC 9110 §14) — función pura
 * ------------------------------------------------------------------ */

/** Lo más que entrega un 206: el navegador pide el resto en otra petición. */
export const MAX_RANGE_CHUNK = 8 * MB;

export type ByteRange =
  /** Sin `Range` utilizable: 200 con el archivo completo. */
  | { kind: "none" }
  /** 206 con `start..end` (inclusive). */
  | { kind: "partial"; start: number; end: number }
  /** 416 con `Content-Range: bytes *\/size`. */
  | { kind: "unsatisfiable" };

/**
 * Interpreta `Range` para un archivo de `size` bytes.
 *
 *   bytes=a-b  → a..min(b, size-1)
 *   bytes=a-   → a..size-1
 *   bytes=-n   → los últimos n (todo si n ≥ size)
 *
 * Inicio ≥ tamaño o `bytes=-0` → `unsatisfiable` (416). Sintaxis
 * desconocida, b < a, otra unidad o VARIOS rangos → `none`: el RFC permite ignorar
 * `Range` y responder 200 completo (multipart/byteranges no vale la pena
 * aquí). El fin se topa a `maxChunk` bytes desde el inicio.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
  maxChunk: number = MAX_RANGE_CHUNK
): ByteRange {
  if (!header) return { kind: "none" };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: "none" };
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return { kind: "none" };
  if (size <= 0) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isSafeInteger(suffix)) return { kind: "none" };
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    if (!Number.isSafeInteger(start)) return { kind: "none" };
    if (start >= size) return { kind: "unsatisfiable" };
    if (b === "") {
      end = size - 1;
    } else {
      const last = Number(b);
      if (!Number.isSafeInteger(last)) return { kind: "none" };
      // b < a es un rango mal escrito (RFC 9110 §14.1.1): se ignora.
      if (last < start) return { kind: "none" };
      end = Math.min(last, size - 1);
    }
  }
  if (maxChunk > 0) end = Math.min(end, start + maxChunk - 1);
  return { kind: "partial", start, end };
}
