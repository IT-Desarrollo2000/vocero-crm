/**
 * 036 fase 2 — Respuesta de descarga de un .xlsx generado (plantilla o
 * resultado). Nombre ASCII (lo armamos nosotros) y sin caché: la plantilla
 * lleva los nombres del equipo de hoy.
 */
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function xlsxResponse(data: Buffer, fileName: string): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": XLSX_MIME,
      "content-disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
