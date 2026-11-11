-- 034 Material de capacitación de la Ayuda (PDF, videos e imágenes propias).
--
--   training_asset                      una fila por archivo subido por el
--                                       Propietario; los bytes viven en el
--                                       almacenamiento de la instancia bajo
--                                       {org}/capacitacion/{id} (ADR-003).
--   training_asset_help_image_topic_ck  una imagen de tema siempre dice su tema.
--   training_asset_org_kind_pos_idx     la lista de la Ayuda, en orden.
--   training_asset_org_topic_image_uq   UNIQUE parcial: una imagen por
--                                       (org, tema).
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla e índices y DO-block en la clave foránea. El CHECK va
-- dentro del CREATE TABLE (si la tabla ya existe, ya lo tiene). Los
-- REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Núcleo sin bandera: sin filas, la Ayuda se ve igual que antes.

CREATE TABLE IF NOT EXISTS "training_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"topic_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "training_asset_help_image_topic_ck" CHECK ("training_asset"."kind" <> 'help_image' OR "training_asset"."topic_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "training_asset" ADD CONSTRAINT "training_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_asset_org_kind_pos_idx" ON "training_asset" USING btree ("organization_id","kind","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_asset_org_topic_image_uq" ON "training_asset" USING btree ("organization_id","topic_id") WHERE "training_asset"."kind" = 'help_image';
