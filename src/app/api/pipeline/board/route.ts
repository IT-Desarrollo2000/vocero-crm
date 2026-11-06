import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getBranding } from "@/server/branding";
import { agendaEnabled } from "@/server/agenda/flag";
import { canViewBooking, type BookingViewer } from "@/server/agenda/queries";
import { replyModeFor } from "@/server/channels/capabilities";
import { teamModeFor } from "@/server/inbox/queries";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { reportTimezone } from "@/server/reports/timezone";

export const dynamic = "force-dynamic";

/** 032 — Próxima cita futura agendada de cada contacto, VISIBLE para quien mira. */
async function nextBookings(
  organizationId: string,
  contactIds: string[],
  viewer: BookingViewer,
  now: Date
): Promise<Map<string, { id: string; scheduledAtUtc: string }>> {
  const out = new Map<string, { id: string; scheduledAtUtc: string }>();
  // `inArray` con lista vacía no es SQL válido en todas las versiones.
  if (contactIds.length === 0) return out;
  const rows = await getDb()
    .select({
      id: schema.booking.id,
      contactId: schema.booking.contactId,
      scheduledAt: schema.booking.scheduledAt,
      assignedUserId: schema.booking.assignedUserId,
      createdByUserId: schema.booking.createdByUserId,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        inArray(schema.booking.contactId, contactIds),
        eq(schema.booking.kind, "session"),
        eq(schema.booking.status, "agendada"),
        // Una cita del Laboratorio jamás es la «próxima cita» de un cliente.
        eq(schema.booking.isTest, false),
        gt(schema.booking.scheduledAt, now)
      )
    )
    .orderBy(asc(schema.booking.scheduledAt));
  for (const r of rows) {
    // Misma regla que la pantalla Citas (`canViewBooking`): el Vendedor no se
    // entera aquí de una cita que allá no ve.
    if (!r.contactId || out.has(r.contactId) || !canViewBooking(r, viewer)) continue;
    out.set(r.contactId, { id: r.id, scheduledAtUtc: r.scheduledAt.toISOString() });
  }
  return out;
}

/**
 * Datos completos del kanban: etapas ordenadas + tarjetas con su contacto.
 *
 * 032 (aditivo): por tarjeta, quién la atiende, si el cliente espera
 * respuesta, cómo se le puede contestar hoy (misma regla que la Bandeja:
 * `replyModeFor`) y, con la agenda encendida, su próxima cita. Además quién
 * mira (`viewer`), si hay equipo (`teamMode`) y la zona del negocio, para que
 * la tarjeta diga las horas en la hora del negocio y no la del navegador.
 */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const now = new Date();

  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, session.organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const leads = await db
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversationId: schema.conversation.id,
      channel: schema.conversation.channel,
      assignedUserId: schema.conversation.assignedUserId,
      assigneeName: schema.user.name,
      awaitingSince: schema.conversation.awaitingSince,
      lastInboundAt: schema.conversation.lastInboundAt,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, schema.contact.id),
        eq(schema.conversation.isTest, false)
      )
    )
    .leftJoin(schema.user, eq(schema.user.id, schema.conversation.assignedUserId))
    .where(scoped(schema.lead.organizationId, session.organizationId))
    .orderBy(asc(schema.lead.position));

  const viewer = { userId: session.userId, role: session.role };
  // La moneda del negocio viaja con el tablero: el cliente suma sus columnas y
  // necesita saber cuál es la única sumable, sin adivinarla ni pedirla aparte.
  const [{ currency }, businessTimezone, teamMode, bookings] = await Promise.all([
    getBranding(session.organizationId),
    reportTimezone(session.organizationId),
    teamModeFor(session.organizationId, viewer),
    agendaEnabled()
      ? nextBookings(
          session.organizationId,
          [...new Set(leads.map((r) => r.contact.id))],
          viewer,
          now
        )
      : Promise.resolve(null),
  ]);

  return Response.json({
    currency,
    businessTimezone,
    viewer,
    teamMode,
    agenda: bookings !== null,
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      kind: s.kind,
      keepActive: s.keepActive,
    })),
    leads: leads.map((r) => {
      // Sin conversación (alta manual que nunca escribió) no hay canal ni
      // ventana: `replyModeFor("whatsapp", null)` diría «plantilla» y la
      // tarjeta mentiría con «su chat se cerró».
      const conv = r.conversationId !== null && r.channel !== null;
      return {
        id: r.lead.id,
        stageId: r.lead.stageId,
        position: r.lead.position,
        lastActivityAt: r.lead.lastActivityAt?.toISOString() ?? null,
        amountCents: r.lead.amountCents,
        currency: r.lead.currency,
        priority: r.lead.priority,
        contact: {
          id: r.contact.id,
          name: r.contact.name,
          phone: r.contact.phone,
        },
        conversationId: r.conversationId,
        channel: conv ? r.channel : null,
        assignedTo:
          conv && r.assignedUserId
            ? { id: r.assignedUserId, name: r.assigneeName ?? "" }
            : null,
        awaitingSince: conv ? (r.awaitingSince?.toISOString() ?? null) : null,
        lastInboundAt: conv ? (r.lastInboundAt?.toISOString() ?? null) : null,
        window:
          conv && r.channel
            ? {
                open: isWindowOpen(r.lastInboundAt, now),
                remainingMs: windowRemainingMs(r.lastInboundAt, now),
                replyMode: replyModeFor(r.channel, r.lastInboundAt, now),
              }
            : null,
        nextBooking: bookings?.get(r.contact.id) ?? null,
      };
    }),
  });
});
