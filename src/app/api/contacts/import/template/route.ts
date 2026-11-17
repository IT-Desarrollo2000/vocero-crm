import { withAuth } from "@/lib/api";
import { TEMPLATE_FILE_NAME } from "@/lib/contact-import";
import { xlsxResponse } from "@/server/contact-import/http";
import { buildTemplate } from "@/server/contact-import/sheets";
import { listSellerMembers } from "@/server/intake/seller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 036 fase 2 — GET: la plantilla de Excel para el equipo (Propietario), con
 * la lista de Vendedor = los nombres del equipo de hoy.
 * → 200 `.xlsx` (`plantilla-importar-contactos.xlsx`) · 403 al Vendedor.
 */
export const GET = withAuth(
  async (session) => {
    const members = await listSellerMembers(session.organizationId);
    const data = await buildTemplate(members.map((m) => m.name));
    return xlsxResponse(data, TEMPLATE_FILE_NAME);
  },
  { role: "owner" }
);
