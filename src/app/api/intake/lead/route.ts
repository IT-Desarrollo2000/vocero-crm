import { apiError, parseBody } from "@/lib/api";
import { requireIntakeKey } from "@/server/intake/auth";
import { intakeLeadSchema } from "@/server/intake/contract";
import { ingestExternalLead } from "@/server/intake/ingest";
import { normalizeIntakePhone } from "@/server/intake/phone";

export const dynamic = "force-dynamic";

/**
 * 011 — Entrada de leads externos (formulario web, FastApp) desde el ERP.
 * POST /api/intake/lead, header `X-API-Key` (Ajustes → Leads externos).
 *
 * 201 `{ contactId, conversationId, created }` · mismo `lead_id` otra vez →
 * 200 `{ duplicate: true }` (lo que permite el cron de conciliación) · 401
 * clave · 404 bandera apagada · 422 cuerpo o teléfono inválido · 429 tasa.
 *
 * Nunca se loguea la clave ni el payload: solo `lead_id`, `origin` y los
 * últimos 4 del teléfono (en `ingestExternalLead`).
 */
export async function POST(req: Request) {
  const auth = await requireIntakeKey(req);
  if (!auth.ok) return auth.response;

  const body = await parseBody(req, intakeLeadSchema);
  if (!body.ok) return body.response;

  const phone = normalizeIntakePhone(body.data.phone);
  if (!phone) {
    return apiError(
      422,
      "invalid_phone",
      "El teléfono debe ser de 10 dígitos o llevar la lada 52"
    );
  }

  try {
    const result = await ingestExternalLead(auth.organizationId, body.data, phone);
    if (result.duplicate) {
      return Response.json(
        {
          duplicate: true,
          contactId: result.contactId,
          conversationId: result.conversationId,
        },
        { status: 200 }
      );
    }
    return Response.json(
      {
        contactId: result.contactId,
        conversationId: result.conversationId,
        created: result.created,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error(
      `[011] lead ${body.data.lead_id} (${body.data.origin}): error al ingerir:`,
      err instanceof Error ? err.message : "desconocido"
    );
    return apiError(500, "internal", "Error interno");
  }
}
