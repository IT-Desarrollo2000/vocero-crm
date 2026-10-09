import type { StageDto } from "@/lib/types";

/**
 * Color de una etapa del embudo, derivado de su TIPO y su POSICIÓN — nunca de
 * su nombre. Antes se mapeaba "Nuevo", "Interesado"… a mano: en cuanto el
 * dueño renombraba o creaba una etapa, todas quedaban grises.
 *
 * - won / lost: fijos (éxito / peligro), estén donde estén en el tablero.
 * - open: por su lugar ENTRE LAS ABIERTAS ordenadas por `position` (no por la
 *   `position` cruda, que deja huecos al borrar). Con las etapas sembradas
 *   ("Nuevo", "En conversación", "Interesado") se ven igual que antes.
 *
 * Devuelve un color CSS para `style`, no una clase: Tailwind no puede generar
 * clases armadas en tiempo de ejecución.
 */

/** Gris de "sin etapa conocida"; también el de la primera abierta. */
export const STAGE_NEUTRAL = "#9ca3af";

/**
 * Paleta de las abiertas, en orden. Las dos primeras conservan el hex que ya
 * tenían ("Nuevo", "En conversación"): ningún token del tema coincide con
 * ellas. A partir de la tercera, tokens del tema (siguen el modo oscuro). Si
 * hay más abiertas que colores, la paleta se repite.
 */
export const OPEN_STAGE_PALETTE = [
  STAGE_NEUTRAL,
  "#7b93b3",
  "var(--warning)",
  "var(--info)",
  "var(--accent)",
] as const;

export const WON_STAGE_COLOR = "var(--success)";
export const LOST_STAGE_COLOR = "var(--danger)";

type StageRef = Pick<StageDto, "id" | "kind" | "position">;

export function stageColor(
  stage: StageRef | null | undefined,
  stages: readonly StageRef[]
): string {
  if (!stage) return STAGE_NEUTRAL;
  if (stage.kind === "won") return WON_STAGE_COLOR;
  if (stage.kind === "lost") return LOST_STAGE_COLOR;
  const rank = [...stages]
    .filter((s) => s.kind === "open")
    .sort((a, b) => a.position - b.position)
    .findIndex((s) => s.id === stage.id);
  if (rank < 0) return STAGE_NEUTRAL;
  return OPEN_STAGE_PALETTE[rank % OPEN_STAGE_PALETTE.length] ?? STAGE_NEUTRAL;
}

/**
 * Para pantallas cuyo DTO solo trae el NOMBRE de la etapa: se resuelve contra
 * la lista de etapas del pipeline. Nombre desconocido → neutro.
 */
export function stageColorByName(
  name: string | null | undefined,
  stages: readonly (StageRef & Pick<StageDto, "name">)[]
): string {
  if (!name) return STAGE_NEUTRAL;
  return stageColor(
    stages.find((s) => s.name === name),
    stages
  );
}
