-- 022 Archivo de conversaciones y nombre de perfil del contacto.
--
--   contact.profile_name          nombre de perfil del canal (nickname), aparte
--                                 del `name` que pone el equipo. NULL = desconocido.
--   conversation.archived_at      archivada = fuera de las vistas normales
--   conversation.archived_reason  'manual' | 'bulk' | 'auto' (text, sin SQL enum)
--   conversation.archived_by      quién la archivó (user.id, ON DELETE SET NULL)
--   conversation_org_archived_idx (organization_id, archived_at) PARCIAL
--                                 WHERE archived_at IS NOT NULL: vista Archivadas
--   pipeline_stage.keep_active    "No archivar": excepción del archivo masivo/auto
--   inbox_settings                una fila por org (PK organization_id); sin fila
--                                 = auto-archivo apagado, 14 días
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla, columnas e índice, y DO-block en cada clave
-- foránea. Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Aditiva: columnas NULLABLE o con default; el código viejo las ignora.
-- Backfill de profile_name SOLO en WhatsApp (plan 022 §3b.7): ahí el nombre
-- vino del perfil del canal en cada entrante. En Instagram/Messenger el nombre
-- pudo editarse a mano y Graph no se vuelve a consultar, así que copiarlo
-- dejaría un nickname falso. Re-ejecutable: solo toca filas con NULL.

CREATE TABLE IF NOT EXISTS "inbox_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"auto_archive_enabled" boolean DEFAULT false NOT NULL,
	"auto_archive_days" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "profile_name" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "archived_reason" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "archived_by" text;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD COLUMN IF NOT EXISTS "keep_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "inbox_settings" ADD CONSTRAINT "inbox_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation" ADD CONSTRAINT "conversation_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_org_archived_idx" ON "conversation" USING btree ("organization_id","archived_at") WHERE "conversation"."archived_at" IS NOT NULL;--> statement-breakpoint
UPDATE "contact" SET "profile_name" = "name" WHERE "channel" = 'whatsapp' AND "profile_name" IS NULL AND "name" ~ '[[:alpha:]]' AND "name" NOT LIKE 'Contacto de %';
