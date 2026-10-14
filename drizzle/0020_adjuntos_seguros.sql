-- 018 Adjuntos seguros (caché de 30 días).
--
--   media_asset.direction    'in' (lo mandó el cliente) | 'out' (el negocio:
--                            CRM o echo del teléfono). Backfill desde
--                            message.direction. La URL firmada de Instagram
--                            (Bloque 2) solo sirve assets 'out'.
--   media_asset.source_url   URL de origen de un entrante de Messenger o
--                            Instagram (CDN de Meta); NULL en WhatsApp.
--
-- `fetch_status` gana 'expired' y 'blocked': la columna es text, sin SQL.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en columnas; el UPDATE solo toca filas que aún dicen 'in'.
-- Tablas sin calificar el esquema (ver scripts/migrate.mjs: search_path).

ALTER TABLE "media_asset" ADD COLUMN IF NOT EXISTS "direction" text DEFAULT 'in' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN IF NOT EXISTS "source_url" text;--> statement-breakpoint
UPDATE "media_asset" SET "direction" = 'out'
FROM "message"
WHERE "message"."media_asset_id" = "media_asset"."id"
  AND "message"."direction" = 'out'
  AND "media_asset"."direction" <> 'out';
