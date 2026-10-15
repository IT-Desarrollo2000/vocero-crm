-- 019 Catálogo de productos (categorías → productos → variantes → archivos).
--
--   product_category          categorías de un nivel por org, orden por position
--   product                   producto; category_id ON DELETE SET NULL; code
--                             opcional, único por org sin distinguir mayúsculas
--                             (índice único parcial sobre lower(code))
--   product_variant           variante (product_id CASCADE); mismo índice de code
--   product_file              imagen/documento (variant_id NULL = compartido);
--                             storage_provider + storage_key = dónde vive el binario
--   product_file_upload       fase B: id reutilizable ya subido a Meta;
--                             UNIQUE (product_file_id, channel, account_id)
--   quick_reply.product_id    atajo ligado a producto (ON DELETE SET NULL)
--   quick_reply.attach        'images' | 'documents' | 'all' (text, sin SQL enum)
--   media_asset.product_file_id  procedencia de la copia enviada (SET NULL)
--
-- La unicidad CRUZADA de códigos entre producto y variante no cabe en un
-- índice: la verifica el store dentro de la transacción.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tablas, columnas e índices, y DO-block en cada clave
-- foránea. Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Puramente ADITIVA y NULLABLE en las tablas existentes, sin backfill: el
-- código viejo ignora las columnas nuevas.

CREATE TABLE IF NOT EXISTS "product_category" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"category_id" text,
	"name" text NOT NULL,
	"code" text,
	"price" text,
	"description" text,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"price" text,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_file" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_file_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_file_id" text NOT NULL,
	"channel" text NOT NULL,
	"account_id" text NOT NULL,
	"remote_id" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN IF NOT EXISTS "product_file_id" text;--> statement-breakpoint
ALTER TABLE "quick_reply" ADD COLUMN IF NOT EXISTS "product_id" text;--> statement-breakpoint
ALTER TABLE "quick_reply" ADD COLUMN IF NOT EXISTS "attach" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_category" ADD CONSTRAINT "product_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product" ADD CONSTRAINT "product_category_id_product_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "product_category"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_file" ADD CONSTRAINT "product_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_file" ADD CONSTRAINT "product_file_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_file" ADD CONSTRAINT "product_file_variant_id_product_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_file_upload" ADD CONSTRAINT "product_file_upload_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "product_file_upload" ADD CONSTRAINT "product_file_upload_product_file_id_product_file_id_fk" FOREIGN KEY ("product_file_id") REFERENCES "product_file"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_product_file_id_product_file_id_fk" FOREIGN KEY ("product_file_id") REFERENCES "product_file"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quick_reply" ADD CONSTRAINT "quick_reply_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_category_org_pos_idx" ON "product_category" USING btree ("organization_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_org_code_uq" ON "product" USING btree ("organization_id",lower("code")) WHERE "product"."code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_org_pos_idx" ON "product" USING btree ("organization_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_org_code_uq" ON "product_variant" USING btree ("organization_id",lower("code")) WHERE "product_variant"."code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variant_org_product_pos_idx" ON "product_variant" USING btree ("organization_id","product_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_file_org_product_pos_idx" ON "product_file" USING btree ("organization_id","product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_file_upload_file_channel_account_uq" ON "product_file_upload" USING btree ("product_file_id","channel","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_file_upload_org_idx" ON "product_file_upload" USING btree ("organization_id");
