import { count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { nextOffset, parsePage } from "@/lib/pagination";
import type { ContactConversationDto, ContactsPageDto } from "@/lib/types";
import { serializeContact } from "@/server/contacts";
import { origenDeContactos } from "@/server/attribution/store";
import { replyModeFor } from "@/server/channels/capabilities";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { teamModeFor } from "@/server/inbox/queries";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import { reportTimezone } from "@/server/reports/timezone";
import { contactSearchSql } from "@/server/search";

export const dynamic = "force-dynamic";

/**
 * 032 — `archived`: `exclude` (por defecto) solo activos; `only` solo
 * archivados (la pestaña «Archivados»). `true` es el parámetro viejo de
 * «Ver archivados» y se conserva con su sentido de entonces: activos Y
 * archivados (lo usa `e2e-contactos-paginacion`).
 */
type ArchivedFilter = "exclude" | "only" | "all";
function parseArchived(raw: string | null): ArchivedFilter {
  if (raw === "only") return "only";
  if (raw === "true") return "all";
  return "exclude";
}

/** 032 — La conversación real de cada contacto de la página, en UN lote. */
async function conversacionesDe(
  organizationId: string,
  contactIds: string[],
  now: Date
): Promise<Map<string, ContactConversationDto>> {
  const out = new Map<string, ContactConversationDto>();
  // `inArray` con lista vacía no es SQL válido en todas las versiones.
  if (contactIds.length === 0) return out;
  const rows = await getDb()
    .select({
      id: schema.conversation.id,
      contactId: schema.conversation.contactId,
      channel: schema.conversation.channel,
      assignedUserId: schema.conversation.assignedUserId,
      assigneeName: schema.user.name,
      lastInboundAt: schema.conversation.lastInboundAt,
    })
    .from(schema.conversation)
    .leftJoin(schema.user, eq(schema.user.id, schema.conversation.assignedUserId))
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        inArray(schema.conversation.contactId, contactIds),
        // A lo sumo una real por contacto (`conversation_org_contact_real_uq`);
        // las del Laboratorio no cuentan.
        eq(schema.conversation.isTest, false)
      )
    );
  for (const r of rows) {
    out.set(r.contactId, {
      id: r.id,
      channel: r.channel,
      assignedTo: r.assignedUserId
        ? { id: r.assignedUserId, name: r.assigneeName ?? "" }
        : null,
      lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
      window: {
        open: isWindowOpen(r.lastInboundAt, now),
        remainingMs: windowRemainingMs(r.lastInboundAt, now),
        replyMode: replyModeFor(r.channel, r.lastInboundAt, now),
      },
    });
  }
  return out;
}

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const stage = url.searchParams.get("stage")?.trim();
  const archived = parseArchived(url.searchParams.get("archived"));
  const now = new Date();
  const viewer = { userId: session.userId, role: session.role };
  // Paginado: antes era un `.limit(200)` mudo y el contacto 201 desaparecía
  // del directorio (y de la búsqueda) sin aviso.
  const page = parsePage(url.searchParams);

  const db = getDb();

  // Etapa de cada contacto en una consulta aparte: una subconsulta
  // correlacionada aquí choca con el `id` de `lead` ("column reference id is
  // ambiguous"), y un join duplicaría contactos con más de un lead.
  const leadStages = await db
    .select({
      contactId: schema.lead.contactId,
      stageName: schema.pipelineStage.name,
      priority: schema.lead.priority,
    })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.pipelineStage.id, schema.lead.stageId)
    )
    .where(scoped(schema.lead.organizationId, session.organizationId));
  const stageByContact = new Map(
    leadStages.map((r) => [r.contactId, r.stageName])
  );
  const priorityByContact = new Map(
    leadStages.map((r) => [r.contactId, r.priority])
  );

  // Búsqueda tolerante (acentos/teléfono), compartida con la Bandeja (06).
  const search = contactSearchSql(q);

  // Todos los filtros (etapa y archivados incluidos) van en SQL ANTES de
  // paginar: filtrar después del corte devolvería páginas cortas sin ser la
  // última y un `total` que no cuadra con lo que se puede recorrer.
  const stageContactIds = stage
    ? leadStages.filter((r) => r.stageName === stage).map((r) => r.contactId)
    : null;
  const [teamMode, businessTimezone] = await Promise.all([
    teamModeFor(session.organizationId, viewer),
    reportTimezone(session.organizationId),
  ]);
  if (stageContactIds?.length === 0) {
    const empty: ContactsPageDto = {
      contacts: [],
      total: 0,
      nextOffset: null,
      counts: { active: 0, archived: 0 },
      viewer,
      teamMode,
      businessTimezone,
    };
    return Response.json(empty);
  }

  // Búsqueda y etapa, sin el corte por archivado: de aquí salen los números
  // de «Activos · N / Archivados · M».
  const base = [
    search,
    stageContactIds ? inArray(schema.contact.id, stageContactIds) : undefined,
  ];
  const where = scoped(
    schema.contact.organizationId,
    session.organizationId,
    ...base,
    archived === "only"
      ? isNotNull(schema.contact.archivedAt)
      : archived === "exclude"
        ? isNull(schema.contact.archivedAt)
        : undefined
  );

  const [rows, totals, actives, archives] = await Promise.all([
    db
      .select()
      .from(schema.contact)
      .where(where)
      // El `id` desempata: con `updatedAt` iguales, un orden no determinista
      // repetiría o saltaría contactos entre una página y la siguiente.
      .orderBy(desc(schema.contact.updatedAt), desc(schema.contact.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ n: count() }).from(schema.contact).where(where),
    db
      .select({ n: count() })
      .from(schema.contact)
      .where(
        scoped(schema.contact.organizationId, session.organizationId, ...base, isNull(schema.contact.archivedAt))
      ),
    db
      .select({ n: count() })
      .from(schema.contact)
      .where(
        scoped(schema.contact.organizationId, session.organizationId, ...base, isNotNull(schema.contact.archivedAt))
      ),
  ]);
  const total = Number(totals[0]?.n ?? 0);

  // 020 — Fuente deducida por el origen (anuncio o publicación), en UN lote sobre la
  // página: la lista dice lo mismo que el detalle del contacto. 032 — y su
  // conversación, también en un lote (sin N+1).
  const ids = rows.map((c) => c.id);
  const [origenes, conversaciones] = await Promise.all([
    origenDeContactos(session.organizationId, ids),
    conversacionesDe(session.organizationId, ids, now),
  ]);
  const contacts = rows.map((c) => ({
    ...serializeContact(
      c,
      stageByContact.get(c.id) ?? null,
      priorityByContact.get(c.id) ?? null,
      origenes.get(c.id) ?? "none"
    ),
    conversation: conversaciones.get(c.id) ?? null,
  }));
  const body: ContactsPageDto = {
    contacts,
    total,
    nextOffset: nextOffset(page, rows.length, total),
    counts: {
      active: Number(actives[0]?.n ?? 0),
      archived: Number(archives[0]?.n ?? 0),
    },
    viewer,
    teamMode,
    businessTimezone,
  };
  return Response.json(body);
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * EXIGE código de país. Un número local crearía un contacto que jamás casaría
   * con los mensajes entrantes —Meta siempre manda la identidad completa— y el
   * dueño acabaría con dos fichas de la misma persona. No se asume un país:
   * diez dígitos son válidos en varios, y asumir mal produce un número
   * silenciosamente equivocado.
   */
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/, "Teléfono en dígitos, con código de país (ej. 5215512345678)"),
  notes: z.string().max(4000).optional(),
  source: z.enum(["anuncio", "organico", "referido", "conocido", "otro", "web", "promotor"]).optional(),
  /** Etapa inicial del lead; si no viene, la primera abierta del tablero. */
  stageId: z.string().min(1).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  // 003: la identidad WhatsApp se deriva del teléfono normalizado.
  const phone = normalizeMx(body.data.phone);
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId: session.organizationId,
      name: body.data.name,
      phone,
      waIdentity: phone,
      notes: body.data.notes ?? null,
      source: body.data.source ?? null,
    })
    // El canal entra en el target porque entra en el índice único desde 014
    // (`contact_org_channel_identity_uq`). Postgres exige que el ON CONFLICT
    // nombre EXACTAMENTE las columnas de un índice existente: sin `channel`,
    // el alta manual falla con "no unique or exclusion constraint matching".
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (!inserted[0]) {
    return apiError(409, "duplicate", "Ya existe un contacto con ese teléfono");
  }

  // Y su lead: un contacto sin lead es invisible en el Pipeline, que es la
  // pantalla donde se trabaja el embudo. Dar de alta a alguien y no verlo ahí
  // es la mitad de la función.
  const lead = await createLeadForContact({
    organizationId: session.organizationId,
    contactId: inserted[0].id,
    stageId: body.data.stageId,
    source: "dueno",
    actorUserId: session.userId,
  });
  if (!lead) {
    return apiError(
      422,
      "no_stage",
      "El tablero no tiene etapas abiertas donde colocar al prospecto"
    );
  }

  return Response.json(
    { contact: serializeContact(inserted[0]), lead: { id: lead.id } },
    { status: 201 }
  );
});
