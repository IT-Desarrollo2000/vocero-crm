import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getContactById } from "@/server/contacts";
import { isOwner } from "@/lib/roles";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { gateSend } from "@/server/inbox/queries";
import { SendError } from "@/server/inbox/send";
import { isWindowOpen } from "@/server/inbox/window";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  templateId: z.string().min(1),
  variables: z.array(z.string().trim().max(500)).max(10).optional(),
});

/**
 * Abre la conversación con un contacto que NUNCA ha escrito (capturado
 * a mano). WhatsApp solo permite iniciar con plantilla aprobada; esa es una
 * regla de Meta, no del CRM.
 *
 * La conversación se crea AQUÍ y no al capturar el contacto: un hilo vacío
 * ensuciaría la Bandeja y rompería su orden por último mensaje.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  // 017: solo WhatsApp se abre con plantilla. En Instagram y Messenger la
  // persona tiene que escribir primero; y sin este corte se crearía una
  // conversación de WhatsApp para un contacto que no tiene número.
  if (contact.channel !== "whatsapp") {
    return apiError(
      422,
      "unsupported_channel",
      "En este canal no se puede iniciar la conversación: la persona tiene que escribir primero"
    );
  }
  if (!contact.phone && !contact.waIdentity) {
    return apiError(422, "no_identity", "Este contacto no tiene a dónde escribir");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const existing = await db
    .select({
      id: schema.conversation.id,
      lastInboundAt: schema.conversation.lastInboundAt,
      assignedUserId: schema.conversation.assignedUserId,
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        session.organizationId,
        eq(schema.conversation.contactId, id),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);

  // 09 (RF-09-08): el contacto es del directorio compartido (D-09-1), pero
  // su conversación puede ser de otro vendedor. Se avisa con 409 (no 404: el
  // Vendedor sí ve el contacto y necesita saber por qué no puede escribirle)
  // sin decir quién la tiene. Va ANTES del aviso de ventana: no revela el
  // estado de una conversación ajena. El Propietario ve todo y no se
  // auto-asigna (D-09-3): para él no aplica.
  const seller = !isOwner(session);
  const assignedToOther = (assignee: string | null) =>
    assignee !== null && assignee !== session.userId;
  if (seller && existing[0] && assignedToOther(existing[0].assignedUserId)) {
    return assignedToOtherError();
  }

  // Gastar una plantilla teniendo la ventana abierta es tirar dinero y
  // reputación de plantilla: se avisa en vez de enviarla.
  if (existing[0] && isWindowOpen(existing[0].lastInboundAt)) {
    return apiError(
      409,
      "window_open",
      "Esta persona te escribió hace menos de 24 h: puedes responderle directo desde la Bandeja, sin plantilla"
    );
  }

  const conversation =
    existing[0] ?? (await getOrCreateConversation(session.organizationId, id));

  // 09: el Vendedor que inicia queda como responsable; el reclamo atómico es
  // la compuerta (si otro la tomó en medio, la plantilla no sale).
  const previousAssignee = existing[0]?.assignedUserId ?? null;
  if (!(await gateSend(session, conversation.id, previousAssignee))) {
    return assignedToOtherError();
  }

  try {
    const result = await sendTemplate({
      organizationId: session.organizationId,
      conversationId: conversation.id,
      templateId: body.data.templateId,
      variables: body.data.variables,
    });
    return Response.json({
      messageId: result.messageId,
      conversationId: conversation.id,
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(409, err.code, err.message);
    }
    throw err;
  }
});

/** 409 de RF-09-08 — sin nombre: el Vendedor no puede ver de quién es. */
function assignedToOtherError(): Response {
  return apiError(
    409,
    "assigned_to_other",
    "Esta conversación la atiende otro vendedor"
  );
}
