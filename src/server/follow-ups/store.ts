import { and, asc, count, desc, eq, lt, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { isOwner, type Role } from "@/lib/roles";
import {
  dueAtFromWall,
  nextRepeatDue,
  postponeDue,
  type FollowUpCreateBody,
  type FollowUpDto,
  type FollowUpPatchBody,
  type FollowUpStatus,
  type RepeatMonths,
} from "@/lib/follow-ups";
import { reportTimezone } from "@/server/reports/timezone";

/**
 * 035 — Recordatorios internos del vendedor. La ÚNICA puerta que escribe
 * `follow_up`.
 *
 * Visibilidad: el Vendedor solo los suyos (un id ajeno es 404, igual que si no
 * existiera); el Propietario todos —y puede marcarlos hechos o posponerlos,
 * como supervisa las citas—, pero los que crea son suyos.
 */

export type FollowUpViewer = { userId: string; role: Role };

export class FollowUpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "not_found" | "contact_not_found" | "invalid_conversation" | "invalid_date" | "already_done",
    message: string
  ) {
    super(message);
    this.name = "FollowUpError";
  }
}

const F = schema.followUp;

/** Columnas del DTO: contacto, dueño, chat real de HOY y etapa del trato. */
function baseSelect() {
  return getDb()
    .select({
      fu: F,
      contactName: schema.contact.name,
      userName: schema.user.name,
      conversationId: schema.conversation.id,
      stageName: schema.pipelineStage.name,
    })
    .from(F)
    .innerJoin(schema.contact, eq(schema.contact.id, F.contactId))
    .innerJoin(schema.user, eq(schema.user.id, F.userId))
    // La conversación real del contacto (una por contacto; las de prueba no):
    // un recordatorio creado desde Contactos encuentra su chat si nace después.
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, F.contactId),
        eq(schema.conversation.organizationId, F.organizationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .leftJoin(schema.lead, eq(schema.lead.contactId, F.contactId))
    .leftJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["where"]>>[number];

function toDto(r: Row): FollowUpDto {
  return {
    id: r.fu.id,
    contact: { id: r.fu.contactId, name: r.contactName },
    conversationId: r.conversationId ?? null,
    user: { id: r.fu.userId, name: r.userName },
    dueAt: r.fu.dueAt.toISOString(),
    reason: r.fu.reason,
    note: r.fu.note,
    repeatMonths: (r.fu.repeatMonths as RepeatMonths | null) ?? null,
    status: r.fu.status,
    doneAt: r.fu.doneAt?.toISOString() ?? null,
    doneNote: r.fu.doneNote,
    createdFrom: r.fu.createdFrom,
    stageName: r.stageName ?? null,
    createdAt: r.fu.createdAt.toISOString(),
  };
}

/** El Vendedor siempre se ve a sí mismo; el Propietario, a quien pida (o a todos). */
export function scopeUserId(viewer: FollowUpViewer, requested?: string | null): string | null {
  if (!isOwner(viewer)) return viewer.userId;
  return requested?.trim() ? requested.trim() : null;
}

export type ListFollowUpsOptions = {
  status?: FollowUpStatus;
  contactId?: string;
  /** Solo cuenta para el Propietario (filtro «Vendedor»). */
  userId?: string | null;
};

/** Lista: abiertos por hora (el más próximo primero) o hechos (el último primero). */
export async function listFollowUps(
  organizationId: string,
  viewer: FollowUpViewer,
  opts: ListFollowUpsOptions = {}
): Promise<FollowUpDto[]> {
  const status = opts.status ?? "open";
  const userId = scopeUserId(viewer, opts.userId);
  const rows = await baseSelect()
    .where(
      scoped(
        F.organizationId,
        organizationId,
        eq(F.status, status),
        userId ? eq(F.userId, userId) : undefined,
        opts.contactId ? eq(F.contactId, opts.contactId) : undefined
      )
    )
    .orderBy(...(status === "open" ? [asc(F.dueAt), asc(F.id)] : [desc(F.doneAt), desc(F.id)]))
    .limit(status === "open" ? 2000 : 50);
  return rows.map(toDto);
}

async function getOne(organizationId: string, id: string): Promise<FollowUpDto | null> {
  const rows = await baseSelect()
    .where(scoped(F.organizationId, organizationId, eq(F.id, id)))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

/** El recordatorio si quien mira puede tocarlo; si no, 404 (sin distinguir). */
async function getVisible(
  organizationId: string,
  viewer: FollowUpViewer,
  id: string
): Promise<FollowUpDto> {
  const fu = await getOne(organizationId, id);
  if (!fu || (!isOwner(viewer) && fu.user.id !== viewer.userId)) {
    throw new FollowUpError(404, "not_found", "No existe ese recordatorio");
  }
  return fu;
}

/** Crea un recordatorio de quien mira, a la hora de pared del negocio. */
export async function createFollowUp(
  organizationId: string,
  viewer: FollowUpViewer,
  body: FollowUpCreateBody
): Promise<FollowUpDto> {
  const db = getDb();
  const [contact] = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, body.contactId)))
    .limit(1);
  if (!contact) throw new FollowUpError(404, "contact_not_found", "No existe ese contacto");

  let conversationId: string | null = null;
  if (body.conversationId) {
    const [conv] = await db
      .select({ id: schema.conversation.id, isTest: schema.conversation.isTest })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, body.conversationId),
          eq(schema.conversation.contactId, body.contactId)
        )
      )
      .limit(1);
    // Una conversación del Laboratorio no es un cliente: nada que recordar.
    if (!conv || conv.isTest) {
      throw new FollowUpError(422, "invalid_conversation", "Esa conversación no es de este contacto");
    }
    conversationId = conv.id;
  }

  const tz = await reportTimezone(organizationId);
  const dueAt = dueAtFromWall(body.day, body.time, tz);
  if (!dueAt) throw new FollowUpError(422, "invalid_date", "No se entiende esa fecha");

  const id = newId("followUp");
  await db.insert(F).values({
    id,
    organizationId,
    contactId: body.contactId,
    conversationId,
    userId: viewer.userId,
    dueAt,
    reason: body.reason,
    note: body.note,
    repeatMonths: body.repeatMonths,
    status: "open",
    createdFrom: "manual",
  });
  return (await getOne(organizationId, id))!;
}

export type FollowUpPatchResult = { followUp: FollowUpDto; next: FollowUpDto | null };

/** Hecho (con «¿Qué pasó?» y, si se repite, el siguiente) · posponer · otra fecha. */
export async function patchFollowUp(
  organizationId: string,
  viewer: FollowUpViewer,
  id: string,
  body: FollowUpPatchBody,
  now: Date = new Date()
): Promise<FollowUpPatchResult> {
  const current = await getVisible(organizationId, viewer, id);
  if (current.status !== "open") {
    throw new FollowUpError(409, "already_done", "Ese recordatorio ya está hecho");
  }
  const db = getDb();
  const tz = await reportTimezone(organizationId);
  const openOnly = (): SQL =>
    scoped(F.organizationId, organizationId, eq(F.id, id), eq(F.status, "open"));

  if (body.action === "done") {
    const nextId = await db.transaction(async (tx) => {
      // `status = 'open'` en el WHERE: dos clics (o dos pestañas) no crean dos
      // siguientes; el segundo no encuentra fila y responde 409.
      const closed = await tx
        .update(F)
        .set({ status: "done", doneAt: now, doneNote: body.note, updatedAt: now })
        .where(openOnly())
        .returning({ id: F.id });
      if (closed.length === 0) {
        throw new FollowUpError(409, "already_done", "Ese recordatorio ya está hecho");
      }
      if (!current.repeatMonths) return null;
      const nid = newId("followUp");
      await tx.insert(F).values({
        id: nid,
        organizationId,
        contactId: current.contact.id,
        conversationId: current.conversationId,
        // El siguiente es del mismo dueño, aunque lo cierre el Propietario.
        userId: current.user.id,
        dueAt: nextRepeatDue(current.dueAt, current.repeatMonths, tz),
        reason: current.reason,
        note: current.note,
        repeatMonths: current.repeatMonths,
        status: "open",
        createdFrom: current.createdFrom,
      });
      return nid;
    });
    return {
      followUp: (await getOne(organizationId, id))!,
      next: nextId ? await getOne(organizationId, nextId) : null,
    };
  }

  const dueAt =
    body.action === "postpone"
      ? postponeDue(current.dueAt, body.preset, now, tz)
      : dueAtFromWall(body.day, body.time, tz);
  if (!dueAt) throw new FollowUpError(422, "invalid_date", "No se entiende esa fecha");
  const moved = await db
    .update(F)
    .set({ dueAt, updatedAt: now })
    .where(openOnly())
    .returning({ id: F.id });
  if (moved.length === 0) {
    throw new FollowUpError(409, "already_done", "Ese recordatorio ya está hecho");
  }
  return { followUp: (await getOne(organizationId, id))!, next: null };
}

/**
 * El número rojo del menú: los recordatorios PROPIOS ya vencidos. Una cuenta
 * sobre `follow_up_org_user_status_due_idx`; nada más.
 */
export async function countOverdue(
  organizationId: string,
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(F)
    .where(
      scoped(F.organizationId, organizationId, eq(F.userId, userId), eq(F.status, "open"), lt(F.dueAt, now))
    );
  return row?.n ?? 0;
}
