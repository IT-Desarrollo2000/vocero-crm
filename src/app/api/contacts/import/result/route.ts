import { parseBody, withAuth } from "@/lib/api";
import { resultFileName, resultSheetSchema } from "@/lib/contact-import";
import { xlsxResponse } from "@/server/contact-import/http";
import { buildResultSheet } from "@/server/contact-import/sheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 036 fase 2 — POST `{ event, rows[] }`: el resultado por renglón en .xlsx
 * (Renglón, Nombre, WhatsApp, Vendedor, Resultado, Asignación). Lo arma el
 * servidor para que exceljs no viaje al navegador; no lee ni escribe la BD.
 */
export const POST = withAuth(
  async (_session, req: Request) => {
    const body = await parseBody(req, resultSheetSchema);
    if (!body.ok) return body.response;
    const data = await buildResultSheet(body.data.rows);
    return xlsxResponse(data, resultFileName(body.data.event));
  },
  { role: "owner" }
);
