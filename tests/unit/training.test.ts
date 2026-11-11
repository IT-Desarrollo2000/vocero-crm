import { describe, expect, it } from "vitest";
import { HELP_TOPICS } from "@/lib/help/topics";
import {
  formatDuration,
  formatSizeMb,
  HELP_TOPIC_IDS,
  MAX_RANGE_CHUNK,
  parseByteRange,
  TRAINING_RULES,
  trainingPatchSchema,
  trainingReorderSchema,
  trainingTopicIdSchema,
  trainingUploadSchema,
} from "@/lib/training";
import { serializeTrainingAsset, type TrainingAssetRow } from "@/server/training/dto";
import { assertCatalogKey, catalogStorageKey, StorageError, trainingStorageKey } from "@/server/catalog/storage/types";
import { trainingBoxIntro } from "@/components/help/training-media";

/**
 * 034 — Material de capacitación de la Ayuda: lo puro (Range, validación de
 * tema y campos, DTO sin rastro del almacenamiento, claves por espacio).
 */

describe("parseByteRange", () => {
  const size = 1000;

  it("sin cabecera → none (200 completo)", () => {
    expect(parseByteRange(null, size)).toEqual({ kind: "none" });
    expect(parseByteRange("", size)).toEqual({ kind: "none" });
  });

  it("bytes=0-99 → 0..99", () => {
    expect(parseByteRange("bytes=0-99", size)).toEqual({ kind: "partial", start: 0, end: 99 });
  });

  it("bytes=0- (lo primero que pide Chrome) → todo", () => {
    expect(parseByteRange("bytes=0-", size)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("bytes=0-1 (la sonda de Safari)", () => {
    expect(parseByteRange("bytes=0-1", size)).toEqual({ kind: "partial", start: 0, end: 1 });
  });

  it("sufijo bytes=-500 → los últimos 500; mayor que el archivo → todo", () => {
    expect(parseByteRange("bytes=-500", size)).toEqual({ kind: "partial", start: 500, end: 999 });
    expect(parseByteRange("bytes=-5000", size)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("fin más allá del archivo se recorta", () => {
    expect(parseByteRange("bytes=900-5000", size)).toEqual({ kind: "partial", start: 900, end: 999 });
  });

  it("inicio ≥ tamaño o sufijo 0 → unsatisfiable (416)", () => {
    expect(parseByteRange("bytes=1000-", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=5000-6000", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-0", size)).toEqual({ kind: "unsatisfiable" });
  });

  it("sintaxis rara, otra unidad, b < a o varios rangos → none", () => {
    for (const h of ["bytes=abc", "items=0-9", "bytes=-", "bytes=5-3", "bytes=0-9,20-29", "0-9", "bytes=1e3-"]) {
      expect(parseByteRange(h, size), h).toEqual({ kind: "none" });
    }
  });

  it("espacios y mayúsculas se toleran", () => {
    expect(parseByteRange("Bytes = 10 - 19", size)).toEqual({ kind: "partial", start: 10, end: 19 });
  });

  it("un 206 se topa a MAX_RANGE_CHUNK desde el inicio", () => {
    const big = 100 * 1024 * 1024;
    expect(parseByteRange("bytes=0-", big)).toEqual({ kind: "partial", start: 0, end: MAX_RANGE_CHUNK - 1 });
    expect(parseByteRange("bytes=10-", big, 100)).toEqual({ kind: "partial", start: 10, end: 109 });
    expect(parseByteRange("bytes=10-19", big, 0)).toEqual({ kind: "partial", start: 10, end: 19 });
  });
});

describe("tema de la Ayuda (z.enum de HELP_TOPICS)", () => {
  it("acepta todos los ids de la guía y solo esos", () => {
    expect(HELP_TOPIC_IDS).toEqual(HELP_TOPICS.map((t) => t.id));
    for (const id of HELP_TOPIC_IDS) expect(trainingTopicIdSchema.safeParse(id).success).toBe(true);
    for (const bad of ["", "Plantillas", "plantillas ", "../x", "inventado"]) {
      expect(trainingTopicIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("trainingUploadSchema (campos del multipart)", () => {
  it("video: los números llegan como texto; vacío = no vino", () => {
    const r = trainingUploadSchema.parse({ kind: "video", title: "", topicId: "", durationSeconds: "97" });
    expect(r).toEqual({ kind: "video", durationSeconds: 97 });
  });

  it("imagen: sin tema se rechaza; con tema y tamaño, pasa", () => {
    expect(trainingUploadSchema.safeParse({ kind: "help_image" }).success).toBe(false);
    expect(
      trainingUploadSchema.parse({ kind: "help_image", topicId: "plantillas", width: "640", height: "400" })
    ).toEqual({ kind: "help_image", topicId: "plantillas", width: 640, height: 400 });
  });

  it("imagen con replaceId no necesita repetir el tema", () => {
    expect(trainingUploadSchema.safeParse({ kind: "help_image", replaceId: "tra_1" }).success).toBe(true);
  });

  it("documento con tema, tipo inventado, tema inventado o duración rota → inválido", () => {
    for (const bad of [
      { kind: "document", topicId: "plantillas" },
      { kind: "audio" },
      { kind: "video", topicId: "inventado" },
      { kind: "video", durationSeconds: "-1" },
      { kind: "video", durationSeconds: "1.5" },
      { kind: "help_image", topicId: "ia", width: "0" },
      { kind: "document", replaceId: "../x" },
    ]) {
      expect(trainingUploadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("trainingPatchSchema y trainingReorderSchema", () => {
  it("patch: título y/o tema (null = Ninguno); vacío o campos extra no", () => {
    expect(trainingPatchSchema.parse({ title: " Presentación " })).toEqual({ title: "Presentación" });
    expect(trainingPatchSchema.parse({ topicId: null })).toEqual({ topicId: null });
    expect(trainingPatchSchema.safeParse({}).success).toBe(false);
    expect(trainingPatchSchema.safeParse({ title: "" }).success).toBe(false);
    expect(trainingPatchSchema.safeParse({ topicId: "inventado" }).success).toBe(false);
    expect(trainingPatchSchema.safeParse({ title: "x", storageKey: "a" }).success).toBe(false);
  });

  it("reorder: solo documentos o videos, sin repetidos", () => {
    expect(trainingReorderSchema.safeParse({ kind: "video", ids: ["a", "b"] }).success).toBe(true);
    expect(trainingReorderSchema.safeParse({ kind: "help_image", ids: ["a"] }).success).toBe(false);
    expect(trainingReorderSchema.safeParse({ kind: "video", ids: ["a", "a"] }).success).toBe(false);
    expect(trainingReorderSchema.safeParse({ kind: "video", ids: [] }).success).toBe(false);
  });
});

describe("serializeTrainingAsset (DTO de GET /api/training)", () => {
  const base: TrainingAssetRow = {
    id: "tra_1",
    organizationId: "org_1",
    kind: "video",
    title: "La Bandeja",
    topicId: "mis-chats",
    position: 0,
    storageProvider: "azure-blob",
    storageKey: "org_1/capacitacion/tra_1",
    mimeType: "video/mp4",
    sizeBytes: 1816,
    durationSeconds: 109,
    width: null,
    height: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("nunca lleva storage_key, proveedor ni la org", () => {
    const dto = serializeTrainingAsset(base);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/storage|azure|capacitacion\/|org_1/);
    expect(Object.keys(dto).sort()).toEqual(
      ["durationSeconds", "id", "kind", "mimeType", "position", "sizeBytes", "title", "topicId"].sort()
    );
  });

  it("ancho/alto solo en imágenes (y pueden faltar)", () => {
    const img = serializeTrainingAsset({ ...base, kind: "help_image", mimeType: "image/png", durationSeconds: 5, width: 640, height: 400 });
    expect(img).toMatchObject({ width: 640, height: 400, durationSeconds: null });
    const sinDim = serializeTrainingAsset({ ...base, kind: "help_image", mimeType: "image/png" });
    expect(sinDim.width).toBeNull();
    expect("width" in serializeTrainingAsset(base)).toBe(false);
  });
});

describe("formato", () => {
  it("duración m:ss (y h:mm:ss); sin dato → null", () => {
    expect(formatDuration(97)).toBe("1:37");
    expect(formatDuration(1)).toBe("0:01");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-3)).toBeNull();
  });

  it("tamaño en MB con una decimal (mínimo 0.1)", () => {
    expect(formatSizeMb(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatSizeMb(621)).toBe("0.1 MB");
  });

  it("topes del diseño: PDF 25 MB, MP4 100 MB, imagen 5 MB", () => {
    expect(TRAINING_RULES.document.maxBytes).toBe(25 * 1024 * 1024);
    expect(TRAINING_RULES.video.maxBytes).toBe(100 * 1024 * 1024);
    expect(TRAINING_RULES.help_image.maxBytes).toBe(5 * 1024 * 1024);
    expect(TRAINING_RULES.video.mimes).toEqual(["video/mp4"]);
  });
});

describe("claves del almacenamiento por espacio", () => {
  it("las claves del catálogo siguen valiendo; las de capacitación también", () => {
    expect(catalogStorageKey("org_1", "pf_abc")).toBe("org_1/catalog/pf_abc");
    expect(trainingStorageKey("org_1", "tra_abc")).toBe("org_1/capacitacion/tra_abc");
    expect(() => assertCatalogKey("org_1/catalog/pf_abc")).not.toThrow();
    expect(() => assertCatalogKey("org_1/capacitacion/tra_abc")).not.toThrow();
  });

  it("otro espacio o segmentos inseguros → misconfigured", () => {
    for (const k of ["org_1/training/tra_1", "org_1/capacitacion/..", "../capacitacion/tra_1", "org_1/capacitacion/a/b"]) {
      expect(() => assertCatalogKey(k), k).toThrow(StorageError);
    }
    expect(() => trainingStorageKey("org/1", "tra_1")).toThrow(StorageError);
  });
});

describe("trainingBoxIntro (texto del recuadro)", () => {
  const v = (topicId: string | null) =>
    ({ id: "x", kind: "video", title: "x", topicId, position: 0, sizeBytes: 1, durationSeconds: 1, mimeType: "video/mp4" }) as const;
  const titles = { plantillas: "Ya no puedo escribirle al cliente" };

  it("documentos y videos con tema", () => {
    expect(trainingBoxIntro(2, [v("plantillas"), v("plantillas")], titles)).toBe(
      "Los documentos para descargar y los 2 videos completos, en orden. Cada video también aparece en su tema de la guía."
    );
  });

  it("solo un video sin tema visible (p. ej. citas con la agenda apagada)", () => {
    expect(trainingBoxIntro(0, [v("citas")], titles)).toBe("El video completo.");
  });

  it("solo un documento", () => {
    expect(trainingBoxIntro(1, [], titles)).toBe("El documento para descargar.");
  });
});
