import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { readMediaFile } from "@/server/whatsapp/media";
import { inspectForServing, safeFileHeaders } from "@/server/media/serve";
import { verifyMediaToken } from "@/server/media/signed-url";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** Toda falla responde igual: no se distingue token malo de asset ausente. */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

/**
 * 018 (FR-812) — URL firmada de un archivo SALIENTE. Nació para que Instagram
 * lo descargara; hoy Instagram recibe los bytes por subida multipart y esta
 * ruta ya no participa en el envío (se conserva con sus pruebas). PÚBLICA a
 * propósito: quien la pediría es un tercero sin sesión. Su defensa es el token (`src/server/media/signed-url.ts`):
 * HMAC sobre organización + asset + vencimiento de 10 minutos.
 *
 * Solo sirve assets `direction = "out"` de la organización del token
 * (`scoped()`), disponibles en la caché y que vuelvan a pasar la política de
 * archivos, con las mismas cabeceras seguras que `/api/media/[assetId]` y
 * `no-store`. Cualquier otro caso → 404 genérico.
 */
export async function GET(_req: Request, ctx: Params) {
  const { token } = await ctx.params;
  const claims = verifyMediaToken(token);
  if (!claims) return notFound();

  const rows = await getDb()
    .select()
    .from(schema.mediaAsset)
    .where(
      scoped(
        schema.mediaAsset.organizationId,
        claims.organizationId,
        eq(schema.mediaAsset.id, claims.assetId),
        eq(schema.mediaAsset.direction, "out")
      )
    )
    .limit(1);
  const asset = rows[0];
  if (!asset || asset.fetchStatus !== "available" || !asset.storagePath) {
    return notFound();
  }

  let data: Buffer;
  try {
    data = await readMediaFile(claims.organizationId, claims.assetId);
  } catch {
    return notFound();
  }

  const checked = inspectForServing(data, {
    fileName: asset.fileName,
    mime: asset.mimeType,
  });
  if (!checked.ok) return notFound();

  return new Response(new Uint8Array(data), {
    headers: {
      ...safeFileHeaders({
        inspection: checked.inspection,
        fileName: asset.fileName,
        length: data.byteLength,
        cacheControl: "no-store",
      }),
      // Lo descarga un servidor de Meta, no una página: CORP same-origin no
      // protege nada aquí y algún cliente de Meta podría respetarlo.
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
