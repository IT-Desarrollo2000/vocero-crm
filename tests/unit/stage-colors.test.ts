import { describe, expect, it } from "vitest";
import type { StageDto } from "@/lib/types";
import {
  LOST_STAGE_COLOR,
  OPEN_STAGE_PALETTE,
  STAGE_NEUTRAL,
  stageColor,
  stageColorByName,
  WON_STAGE_COLOR,
} from "@/lib/stage-colors";

/** Las etapas que siembra `on-signup.ts`. */
const SEED: StageDto[] = [
  { id: "st_1", name: "Nuevo", position: 0, kind: "open" },
  { id: "st_2", name: "En conversación", position: 1, kind: "open" },
  { id: "st_3", name: "Interesado", position: 2, kind: "open" },
  { id: "st_4", name: "Cliente", position: 3, kind: "won" },
  { id: "st_5", name: "Perdido", position: 4, kind: "lost" },
];

describe("stageColor", () => {
  it("las etapas sembradas conservan su color de siempre", () => {
    expect(stageColorByName("Nuevo", SEED)).toBe("#9ca3af");
    expect(stageColorByName("En conversación", SEED)).toBe("#7b93b3");
    // var(--warning) / --success / --danger valen #b08b5e / #5f8f74 / #a2504c
    // en el tema claro: los mismos hex que tenía el mapa por nombre.
    expect(stageColorByName("Interesado", SEED)).toBe("var(--warning)");
    expect(stageColorByName("Cliente", SEED)).toBe(WON_STAGE_COLOR);
    expect(stageColorByName("Perdido", SEED)).toBe(LOST_STAGE_COLOR);
  });

  it("renombrar una etapa NO le quita el color (el bug)", () => {
    const renamed = SEED.map((s) =>
      s.id === "st_3" ? { ...s, name: "Cotizando" } : s.id === "st_4" ? { ...s, name: "Vendido" } : s
    );
    expect(stageColorByName("Cotizando", renamed)).toBe("var(--warning)");
    expect(stageColorByName("Vendido", renamed)).toBe(WON_STAGE_COLOR);
  });

  it("won y lost son fijos aunque cambien de posición", () => {
    const moved = SEED.map((s) =>
      s.kind === "won" ? { ...s, position: -1 } : s.kind === "lost" ? { ...s, position: 0 } : s
    );
    expect(stageColor(moved.find((s) => s.kind === "won"), moved)).toBe(WON_STAGE_COLOR);
    expect(stageColor(moved.find((s) => s.kind === "lost"), moved)).toBe(LOST_STAGE_COLOR);
  });

  it("las abiertas se colorean por su lugar entre las abiertas, no por position cruda", () => {
    // Huecos (se borró una etapa) y una abierta creada DESPUÉS de las anclas.
    const gaps: StageDto[] = [
      { id: "a", name: "Uno", position: 10, kind: "open" },
      { id: "w", name: "Ganado", position: 20, kind: "won" },
      { id: "b", name: "Dos", position: 35, kind: "open" },
      { id: "c", name: "Tres", position: 50, kind: "open" },
    ];
    expect(stageColorByName("Uno", gaps)).toBe(OPEN_STAGE_PALETTE[0]);
    expect(stageColorByName("Dos", gaps)).toBe(OPEN_STAGE_PALETTE[1]);
    expect(stageColorByName("Tres", gaps)).toBe(OPEN_STAGE_PALETTE[2]);
  });

  it("el orden de la lista recibida no importa", () => {
    const shuffled = [...SEED].reverse();
    expect(stageColorByName("En conversación", shuffled)).toBe("#7b93b3");
  });

  it("más abiertas que colores: la paleta se repite", () => {
    const many: StageDto[] = Array.from({ length: OPEN_STAGE_PALETTE.length + 1 }, (_, i) => ({
      id: `s${i}`,
      name: `E${i}`,
      position: i,
      kind: "open",
    }));
    expect(stageColorByName(`E${OPEN_STAGE_PALETTE.length}`, many)).toBe(OPEN_STAGE_PALETTE[0]);
  });

  it("etapa desconocida o ausente → neutro", () => {
    expect(stageColorByName("No existe", SEED)).toBe(STAGE_NEUTRAL);
    expect(stageColorByName(null, SEED)).toBe(STAGE_NEUTRAL);
    expect(stageColorByName("Nuevo", [])).toBe(STAGE_NEUTRAL);
    expect(stageColor(null, SEED)).toBe(STAGE_NEUTRAL);
    // Una abierta que no está en la lista (lista vieja) tampoco revienta.
    expect(stageColor({ id: "fantasma", kind: "open", position: 1 }, SEED)).toBe(STAGE_NEUTRAL);
  });
});
