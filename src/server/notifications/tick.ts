import { and, count, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  DUE_LOOKBACK_MS,
  READ_RETENTION_DAYS,
  dailySummaryKey,
  dailySummaryWindow,
  followUpDueKey,
  safeErrorTag,
} from "@/lib/notifications";
import { reportTimezone } from "@/server/reports/timezone";
import { createNotifications, purgeReadNotifications, type NewNotification } from "./store";

/**
 * 035 fase B — UNA vuelta del reloj de avisos (por organización):
 *
 *  1. Recordatorio vencido: `follow_up` abierto con `due_at <= now` dentro de
 *     las últimas 24 h y sin aviso para ESE `due_at` → aviso a su dueño.
 *  2. Resumen del día: desde las 08:00 de pared del negocio, uno por usuario
 *     y día si tiene ≥ 1 abierto con `due_at` ≤ fin de hoy.
 *  3. Retención: borra los leídos de más de 60 días.
 *
 * Idempotente: las claves son deterministas y el UNIQUE es el candado (dos
 * réplicas o dos POST del endpoint de pruebas no duplican). El fallo de una
 * organización no detiene a las demás.
 */
export type NotificationTickResult = { due: number; daily: number; purged: number; failedOrgs: number };

const F = schema.followUp;
const N = schema.notification;

/** Claves que ya existen (para no reintentar inserciones a cada vuelta). */
async function existingKeys(organizationId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await getDb()
    .select({ userId: N.userId, key: N.dedupeKey })
    .from(N)
    .where(scoped(N.organizationId, organizationId, inArray(N.dedupeKey, keys)));
  return new Set(rows.map((r) => `${r.userId}|${r.key}`));
}

async function tickOrg(organizationId: string, now: Date): Promise<Omit<NotificationTickResult, "failedOrgs">> {
  const db = getDb();
  const tz = await reportTimezone(organizationId);

  // 1) Vencidos de las últimas 24 h.
  const due = await db
    .select({
      id: F.id,
      userId: F.userId,
      contactId: F.contactId,
      dueAt: F.dueAt,
      reason: F.reason,
      note: F.note,
      contactName: schema.contact.name,
    })
    .from(F)
    .innerJoin(schema.contact, eq(schema.contact.id, F.contactId))
    .where(
      scoped(
        F.organizationId,
        organizationId,
        eq(F.status, "open"),
        lte(F.dueAt, now),
        gt(F.dueAt, new Date(now.getTime() - DUE_LOOKBACK_MS))
      )
    )
    .limit(1000);
  const dueRows: NewNotification[] = due.map((f) => ({
    organizationId,
    userId: f.userId,
    kind: "follow_up_due",
    dedupeKey: followUpDueKey(f.id, f.dueAt),
    followUpId: f.id,
    contactId: f.contactId,
    payload: {
      contactName: f.contactName,
      reason: f.reason,
      note: f.note,
      dueAt: f.dueAt.toISOString(),
    },
  }));

  // 2) Resumen del día (desde las 08:00 de pared).
  const dailyRows: NewNotification[] = [];
  const win = dailySummaryWindow(now, tz);
  if (win) {
    const per = await db
      .select({ userId: F.userId, total: count() })
      .from(F)
      .where(scoped(F.organizationId, organizationId, and(eq(F.status, "open"), lt(F.dueAt, win.endOfDay))))
      .groupBy(F.userId);
    for (const p of per) {
      if (p.total <= 0) continue;
      dailyRows.push({
        organizationId,
        userId: p.userId,
        kind: "daily_summary",
        dedupeKey: dailySummaryKey(win.day),
        payload: { day: win.day, total: p.total },
      });
    }
  }

  const all = [...dueRows, ...dailyRows];
  const seen = await existingKeys(
    organizationId,
    [...new Set(all.map((r) => r.dedupeKey))]
  );
  const fresh = all.filter((r) => !seen.has(`${r.userId}|${r.dedupeKey}`));
  const freshDue = fresh.filter((r) => r.kind === "follow_up_due");
  const freshDaily = fresh.filter((r) => r.kind === "daily_summary");
  // Primero el resumen y después los vencidos: en la campana (más reciente
  // arriba) el vencido queda encima.
  const daily = await createNotifications(freshDaily);
  const dueCount = await createNotifications(freshDue);

  // 3) Retención.
  const purged = await purgeReadNotifications(
    organizationId,
    new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000)
  );
  return { due: dueCount, daily, purged };
}

export async function runNotificationTick(now: Date = new Date()): Promise<NotificationTickResult> {
  const orgs = await getDb().select({ id: schema.organization.id }).from(schema.organization);
  const out: NotificationTickResult = { due: 0, daily: 0, purged: 0, failedOrgs: 0 };
  for (const org of orgs) {
    try {
      const r = await tickOrg(org.id, now);
      out.due += r.due;
      out.daily += r.daily;
      out.purged += r.purged;
    } catch (err) {
      out.failedOrgs++;
      console.error(`[avisos] la vuelta de una organización falló: ${safeErrorTag(err)}`);
    }
  }
  return out;
}
