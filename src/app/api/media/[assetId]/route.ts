import { eq, exists, or, sql } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner } from "@/lib/roles";
import { conversationVisibleTo } from "@/server/inbox/visibility";
import { rm } from "node:fs/promises";
import {
  ensureAssetAvailable,
  mediaFilePath,
  readMediaFile,
} from "@/server/whatsapp/media";
import {
  blockedResponse,
  expiredResponse,
  inspectForServing,
  safeFileHeaders,
} from "@/server/media/serve";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ assetId: string }> };

/**
 * 008 — Sirve el binario de un adjunto desde el volumen local. Solo con
 * sesión y dentro de la organización (un asset ajeno responde 404: jamás se
 * filtra existencia entre tenants). Si el archivo aún no se descargó,
 * intenta on-demand contra Graph; si Meta ya lo expiró → 410.
 *
 * 018 — Expirado por la caché de 30 días → 410 `expired`; bloqueado por la
 * política → 415 `blocked`. Se sirve con el tipo DETECTADO y cabeceras
 * seguras (`src/server/media/serve.ts`).
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { assetId } = await ctx.params;
  if (!/^[\w.-]{1,64}$/.test(assetId)) {
    return apiError(422, "invalid", "assetId inválido");
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mediaAsset)
    .where(
      scoped(
        schema.mediaAsset.organizationId,
        session.organizationId,
        eq(schema.mediaAsset.id, assetId),
        // 09 (D-09-5): al Vendedor solo si el adjunto cuelga de un mensaje
        // de una conversación que ve y que no es del Laboratorio (`is_test`);
        // si no (o sin mensaje) → 404.
        //
        // 020: o si es la miniatura del anuncio de origen de una conversación
        // que ve (no cuelga de ningún mensaje: es del anuncio). Con la misma
        // visibilidad y la misma exclusión del Laboratorio (D4: la tarjeta la
        // ven todos los roles).
        isOwner(session)
          ? undefined
          : or(
              exists(
                db
                  .select({ one: sql`1` })
                  .from(schema.message)
                  .innerJoin(
                    schema.conversation,
                    eq(schema.conversation.id, schema.message.conversationId)
                  )
                  .where(
                    scoped(
                      schema.message.organizationId,
                      session.organizationId,
                      eq(schema.message.mediaAssetId, schema.mediaAsset.id),
                      eq(schema.conversation.organizationId, session.organizationId),
                      eq(schema.conversation.isTest, false),
                      conversationVisibleTo(session)
                    )
                  )
              ),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(schema.adAttribution)
                  .innerJoin(
                    schema.conversation,
                    eq(schema.conversation.id, schema.adAttribution.conversationId)
                  )
                  .where(
                    scoped(
                      schema.adAttribution.organizationId,
                      session.organizationId,
                      eq(schema.adAttribution.imageAssetId, schema.mediaAsset.id),
                      eq(schema.conversation.organizationId, session.organizationId),
                      eq(schema.conversation.isTest, false),
                      conversationVisibleTo(session)
                    )
                  )
              )
            )
      )
    )
    .limit(1);
  let asset = rows[0];
  if (!asset) return apiError(404, "not_found", "Adjunto no encontrado");

  if (asset.kind === "location" || asset.kind === "contacts") {
    // Sin binario: el payload viaja en el DTO del mensaje.
    return apiError(404, "no_binary", "Este adjunto no tiene archivo");
  }

  // 018: estados finales, sin reintento (re-descargar un expirado deshace la
  // caché de 30 días; un bloqueado no se vuelve seguro).
  if (asset.fetchStatus === "expired") return expiredResponse();
  if (asset.fetchStatus === "blocked") {
    return blockedResponse(asset.fetchError ?? "Archivo bloqueado por seguridad");
  }

  if (asset.fetchStatus !== "available") {
    // On-demand: reintenta la descarga en el momento (pending o failed).
    asset = (await ensureAssetAvailable(session.organizationId, assetId)) ?? asset;
  }
  if (asset.fetchStatus === "blocked") {
    return blockedResponse(asset.fetchError ?? "Archivo bloqueado por seguridad");
  }
  if (asset.fetchStatus !== "available" || !asset.storagePath) {
    return apiError(
      410,
      "gone",
      "El contenido ya no está disponible (expiró en la plataforma antes de poder copiarse)"
    );
  }

  let data: Buffer;
  try {
    data = await readMediaFile(session.organizationId, assetId);
  } catch {
    return apiError(410, "gone", "El archivo del adjunto no está en el volumen");
  }

  // 018: re-inspección al servir — los assets anteriores guardaron el MIME
  // del remitente. Si ya no pasa la política, se marca y no se entrega.
  const checked = inspectForServing(data, {
    fileName: asset.fileName,
    mime: asset.mimeType,
  });
  if (!checked.ok) {
    await db
      .update(schema.mediaAsset)
      .set({ fetchStatus: "blocked", fetchError: checked.reason, updatedAt: new Date() })
      .where(
        scoped(
          schema.mediaAsset.organizationId,
          session.organizationId,
          eq(schema.mediaAsset.id, assetId)
        )
      );
    await rm(mediaFilePath(session.organizationId, assetId), { force: true }).catch(
      () => {}
    );
    return checked.response;
  }

  return new Response(new Uint8Array(data), {
    headers: safeFileHeaders({
      inspection: checked.inspection,
      fileName: asset.fileName,
      length: data.byteLength,
      // El contenido de un asset es inmutable; privado por sesión.
      cacheControl: "private, max-age=86400",
    }),
  });
});
