import type { schema } from "@/lib/db";
import type { TrainingAssetDto } from "@/lib/training";

/**
 * 034 — Fila → DTO de `GET /api/training`. Puro (un test lo cubre): lo que
 * llega al navegador NUNCA trae `storage_key` ni `storage_provider` (dónde
 * viven los bytes es asunto de la instancia), y el ancho/alto solo va en las
 * imágenes.
 */
export type TrainingAssetRow = typeof schema.trainingAsset.$inferSelect;

export function serializeTrainingAsset(r: TrainingAssetRow): TrainingAssetDto {
  const dto: TrainingAssetDto = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    topicId: r.topicId,
    position: r.position,
    sizeBytes: r.sizeBytes,
    durationSeconds: r.kind === "video" ? r.durationSeconds : null,
    mimeType: r.mimeType,
  };
  if (r.kind === "help_image") {
    dto.width = r.width;
    dto.height = r.height;
  }
  return dto;
}
