import { and, count, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { todayWindow, type FollowUpCountsDto } from "@/lib/notifications";

const F = schema.followUp;

/**
 * 035 — Los recordatorios PROPIOS abiertos: vencidos (`due_at` < ahora) y los
 * de hoy (`due_at` < fin de hoy en la zona del negocio; incluye los
 * vencidos). Una sola pasada sobre `follow_up_org_user_status_due_idx`.
 * Lo usan el número rojo del menú, la línea de la Bandeja y el resumen del
 * día de la campana.
 */
export async function countFollowUps(
  organizationId: string,
  userId: string,
  now: Date,
  tz: string
): Promise<FollowUpCountsDto> {
  const { endOfDay } = todayWindow(now, tz);
  const [row] = await getDb()
    .select({
      today: count(),
      overdue: sql<number>`count(*) filter (where ${lt(F.dueAt, now)})`.mapWith(Number),
    })
    .from(F)
    .where(
      scoped(
        F.organizationId,
        organizationId,
        and(eq(F.userId, userId), eq(F.status, "open"), lt(F.dueAt, endOfDay))
      )
    );
  return { overdue: row?.overdue ?? 0, today: row?.today ?? 0 };
}
