import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { startReminderTicker } from "@/server/agenda/reminder-ticker";
import { startMediaPurgeTicker } from "@/server/media/purge-ticker";

/**
 * Limpieza al arranque (FR-034): corridas del Laboratorio que quedaron
 * "running" tras un reinicio → fallidas. Solo corre en el runtime Node.
 */
export async function cleanupOrphanRuns(): Promise<void> {
  try {
    const db = getDb();
    const updated = await db
      .update(schema.agentTestRun)
      .set({
        status: "failed",
        error: "Interrumpida por un reinicio del servidor",
        finishedAt: new Date(),
      })
      .where(eq(schema.agentTestRun.status, "running"))
      .returning({ id: schema.agentTestRun.id });
    if (updated.length > 0) {
      console.log(
        `[boot] ${updated.length} corrida(s) del Laboratorio huérfana(s) marcada(s) como fallida(s)`
      );
    }
  } catch (err) {
    // La BD puede no estar lista aún (migraciones corren antes del server).
    console.error("[boot] limpieza de corridas huérfanas falló:", err);
  }
}

/**
 * 10 — Trabajo en segundo plano in-process (sin colas externas). Hoy: el reloj
 * de recordatorios de cita, que solo arranca con AGENDA encendida y
 * `AGENDA_REMINDER_TICK_MS` distinto de 0; y (018) la purga de la caché de
 * adjuntos, que arranca siempre salvo `MEDIA_PURGE_TICK_MS=0`. Nunca tumba
 * el arranque.
 */
export function startBackgroundJobs(): void {
  try {
    startReminderTicker();
  } catch (err) {
    console.error("[boot] el reloj de recordatorios no arrancó:", err);
  }
  try {
    startMediaPurgeTicker();
  } catch (err) {
    console.error("[boot] el reloj de purga de adjuntos no arrancó:", err);
  }
}
