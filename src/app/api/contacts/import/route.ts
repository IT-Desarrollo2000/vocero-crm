import { parseBody, withAuth } from "@/lib/api";
import { importBatchSchema, type ImportBatchDto } from "@/lib/contact-import";
import { importRows } from "@/server/contact-import/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 036 fase 2 — POST `{ event, rows[] }` (hasta 100 renglones; la pantalla
 * manda de 50 en 50, en orden): importa los renglones revisados
 * (Propietario). Mismo camino y mismo `lead_id` que
 * `scripts/importar-leads.mjs`: reintentar o volver a subir el archivo es
 * seguro. Sin bandera: funciona con `LEADS_EXTERNOS` apagada.
 *
 * → 200 `{ results: [{ rowNumber, outcome, assignee }] }` (un renglón que
 *   falla viene como `error`, no tumba el lote) · 422 cuerpo inválido.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    const body = await parseBody(req, importBatchSchema);
    if (!body.ok) return body.response;
    const results = await importRows(session.organizationId, body.data.event, body.data.rows);
    return Response.json({ results } satisfies ImportBatchDto);
  },
  { role: "owner" }
);
