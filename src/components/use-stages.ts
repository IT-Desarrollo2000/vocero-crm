"use client";

import { useCallback, useEffect, useState } from "react";
import type { StageDto } from "@/lib/types";

/**
 * Etapas del pipeline de la organización, en orden de tablero. Para las
 * pantallas cuyo DTO solo trae el nombre de la etapa y necesitan su tipo y
 * posición (el color sale de ahí, ver `lib/stage-colors`).
 *
 * Arranca vacía: sin etapas, todo se pinta neutro hasta que llegan.
 */
export function useStages(): { stages: StageDto[]; reload: () => Promise<void> } {
  const [stages, setStages] = useState<StageDto[]>([]);

  const reload = useCallback(async () => {
    const res = await fetch("/api/pipeline/stages").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as {
      stages?: StageDto[];
    } | null;
    if (data?.stages) setStages(data.stages);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { stages, reload };
}
