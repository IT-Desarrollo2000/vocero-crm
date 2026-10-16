-- 020 Origen de leads: la miniatura del anuncio de origen.
--
--   ad_attribution.image_asset_id   copia del creativo (CDN de Meta, su URL
--                                   caduca en días) guardada como media_asset;
--                                   UNA por source_id. ON DELETE SET NULL.
--   ad_attribution_org_source_idx   (organization_id, source_id): la copia se
--                                   busca y reparte por anuncio.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en columna e índice, y DO-block en la clave foránea. Los
-- REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Puramente ADITIVA y NULLABLE, sin backfill: el código viejo ignora la
-- columna, y las filas de 016 se reparan solas al abrir el contacto.

ALTER TABLE "ad_attribution" ADD COLUMN IF NOT EXISTS "image_asset_id" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ad_attribution" ADD CONSTRAINT "ad_attribution_image_asset_id_media_asset_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "media_asset"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_attribution_org_source_idx" ON "ad_attribution" USING btree ("organization_id","source_id");
