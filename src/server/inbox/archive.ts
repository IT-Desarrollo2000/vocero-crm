import {
  count,
  eq,
  gt,
  isNull,
  lt,
  lte,
  notExists,
  or,
  param,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_INBOX_SETTINGS,
  type InboxSettingsDto,
} from "@/lib/inbox-settings";
import { publish } from "@/server/events/bus";
import { sortAtSql } from "@/server/inbox/list-query";

/**
 * 022 — Archivo de conversaciones (spec 022, plan §3 y §3b).
 *
 * Archivar NUNCA borra: solo marca `archived_at` (+ motivo y autor) y la
 * conversación sale de las vistas normales de la Bandeja. Un entrante o un
 * saliente exitoso la devuelve (`UNARCHIVE_SET`). Las `is_test` nunca se
 * archivan. Todos los cortes de tiempo se calculan en Node y viajan como
 * parámetros (columnas `timestamp` sin zona, nunca `now()` SQL).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Columnas que DESARCHIVAN, para mezclar en los UPDATE de entrante/saliente
 * (`ingest.ts`, `send.ts`, `templates.ts`). Sin `updatedAt` a propósito: un
 * objeto de módulo fijaría la hora de carga; cada UPDATE que lo mezcla ya pone
 * su propio `updatedAt: new Date()`.
 */
export const UNARCHIVE_SET = {
  archivedAt: null,
  archivedReason: null,
  archivedBy: null,
} as const satisfies Partial<typeof schema.conversation.$inferInsert>;

/**
 * Conversaciones que una limpieza (masiva o auto) PUEDE archivar en la org:
 *
 *   coalesce(last_message_at, created_at) < cutoff      (inactiva)
 *   ∧ archived_at IS NULL ∧ is_test = false
 *   ∧ NOT EXISTS cita real `agendada` futura (scheduled_at > now) ligada a la
 *     conversación o a su contacto
 *   ∧ NOT EXISTS lead del contacto en una etapa `keep_active` ("No archivar")
 *   ∧ NOT (handoff_at > cutoff)  — escrito `handoff_at IS NULL ∨ ≤ cutoff`
 *     (con NULL, `NOT (NULL > x)` sería NULL y excluiría todo lo sin handoff).
 *
 * Una sola fuente para la vista previa (`dryRun`), la masiva y la auto.
 * Exportada para el unit que fija su forma.
 */
export function inactiveArchivableCondition(
  organizationId: string,
  opts: { cutoff: Date; now: Date }
): SQL {
  const db = getDb();
  const c = schema.conversation;
  const b = schema.booking;
  const l = schema.lead;
  const s = schema.pipelineStage;
  return scoped(
    c.organizationId,
    organizationId,
    // El corte va con el codificador de la columna (mismo formato que un
    // `lt(columna, Date)`): `sortAtSql` es una expresión y no lo tiene.
    lt(sortAtSql, param(opts.cutoff, c.createdAt)),
    isNull(c.archivedAt),
    eq(c.isTest, false),
    notExists(
      db
        .select({ one: sql`1` })
        .from(b)
        .where(
          scoped(
            b.organizationId,
            organizationId,
            eq(b.isTest, false),
            eq(b.status, "agendada"),
            gt(b.scheduledAt, opts.now),
            or(eq(b.conversationId, c.id), eq(b.contactId, c.contactId))
          )
        )
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(l)
        .innerJoin(s, eq(s.id, l.stageId))
        .where(
          scoped(
            l.organizationId,
            organizationId,
            eq(l.contactId, c.contactId),
            eq(s.keepActive, true)
          )
        )
    ),
    or(isNull(c.handoffAt), lte(c.handoffAt, opts.cutoff))
  );
}

/** Corte de inactividad: `now − days`. */
export function inactivityCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Archiva (o, con `dryRun`, solo cuenta) las inactivas de la org según
 * `inactiveArchivableCondition`. `reason` = `bulk` (limpieza del Propietario,
 * `by` = su user id) o `auto` (ticker, `by` = null). Con algo archivado
 * publica UN `conversations.bulk` (sin ids): los clientes recargan.
 */
export async function archiveInactive(
  organizationId: string,
  opts: {
    days: number;
    reason: "bulk" | "auto";
    by?: string | null;
    dryRun?: boolean;
    now?: Date;
  }
): Promise<{ count: number }> {
  const db = getDb();
  const c = schema.conversation;
  const now = opts.now ?? new Date();
  const where = inactiveArchivableCondition(organizationId, {
    cutoff: inactivityCutoff(now, opts.days),
    now,
  });

  if (opts.dryRun) {
    const rows = await db.select({ n: count() }).from(c).where(where);
    return { count: Number(rows[0]?.n ?? 0) };
  }

  // La marca es la hora real (aunque `now` venga adelantado por la ruta dev):
  // `updated_at` sube para el modo `since` de la lista.
  const stamp = new Date();
  const updated = await db
    .update(c)
    .set({
      archivedAt: stamp,
      archivedReason: opts.reason,
      archivedBy: opts.by ?? null,
      updatedAt: stamp,
    })
    .where(where)
    .returning({ id: c.id });
  if (updated.length > 0) {
    publish(organizationId, {
      type: "conversations.bulk",
      data: { reason: opts.reason },
    });
  }
  return { count: updated.length };
}

/* ------------------------------------------------------------------ *
 * Ajustes de la Bandeja (`inbox_settings`, una fila por org).
 * ------------------------------------------------------------------ */

/** Sin fila = defaults (auto-archivo apagado, 14 días, atrasada a los 60 min). */
export async function getInboxSettings(
  organizationId: string
): Promise<InboxSettingsDto> {
  const t = schema.inboxSettings;
  const rows = await getDb()
    .select({
      autoArchiveEnabled: t.autoArchiveEnabled,
      autoArchiveDays: t.autoArchiveDays,
      overdueMinutes: t.overdueMinutes,
    })
    .from(t)
    .where(scoped(t.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? { ...DEFAULT_INBOX_SETTINGS };
}

/** Upsert por `organization_id` (PK). */
export async function saveInboxSettings(
  organizationId: string,
  settings: InboxSettingsDto
): Promise<InboxSettingsDto> {
  const t = schema.inboxSettings;
  const values = {
    autoArchiveEnabled: settings.autoArchiveEnabled,
    autoArchiveDays: settings.autoArchiveDays,
    overdueMinutes: settings.overdueMinutes,
  };
  await getDb()
    .insert(t)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: [t.organizationId],
      set: { ...values, updatedAt: new Date() },
    });
  return values;
}

export type AutoArchiveResult = {
  now: string;
  /** Organizaciones con el auto-archivo encendido que se recorrieron. */
  organizations: number;
  /** Conversaciones archivadas en total. */
  archived: number;
  /** Organizaciones cuya vuelta falló (se loguea y se sigue). */
  failed: number;
};

/**
 * Una vuelta del auto-archivo: recorre las orgs con el interruptor encendido
 * y archiva sus inactivas con su umbral. Un fallo de una org no corta las
 * demás (patrón de `runReminderTick`). Lo llaman el ticker y la ruta dev.
 */
export async function runAutoArchive(now: Date): Promise<AutoArchiveResult> {
  const t = schema.inboxSettings;
  const result: AutoArchiveResult = {
    now: now.toISOString(),
    organizations: 0,
    archived: 0,
    failed: 0,
  };
  // Lectura transversal a propósito (como `listReminderOrganizations`): el
  // reloj es de la instancia, y cada archivo va luego con `scoped()`.
  const orgs = await getDb()
    .select({ organizationId: t.organizationId, days: t.autoArchiveDays })
    .from(t)
    .where(eq(t.autoArchiveEnabled, true));
  result.organizations = orgs.length;
  for (const org of orgs) {
    try {
      const { count: n } = await archiveInactive(org.organizationId, {
        days: org.days,
        reason: "auto",
        by: null,
        now,
      });
      result.archived += n;
    } catch (err) {
      result.failed += 1;
      console.error(
        `[auto-archive] vuelta de la organización ${org.organizationId} falló:`,
        err
      );
    }
  }
  if (result.archived > 0) {
    console.log(
      `[auto-archive] ${result.archived} conversación(es) archivada(s) en ${result.organizations} organización(es)`
    );
  }
  return result;
}
