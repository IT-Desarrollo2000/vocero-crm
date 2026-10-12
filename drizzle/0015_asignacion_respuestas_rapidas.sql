-- Tarea 09 (equipo): asignación de conversaciones y respuestas rápidas.
--
--   conversation.assigned_user_id  responsable (FK a user, ON DELETE SET NULL);
--                                  NULL = sin asignar
--   conversation.assigned_at       cuándo la tomó su responsable actual
--   conversation_org_assignee_idx  Bandeja por responsable (Mías / Sin asignar)
--   quick_reply                    catálogo de respuestas rápidas por org;
--                                  atajo único por org, orden por position
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitucion IV):
-- IF NOT EXISTS en tabla, columnas e indices, y DO-block en cada clave foranea.
-- Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Es puramente ADITIVA y NULLABLE, sin backfill: las conversaciones existentes
-- quedan sin asignar y el codigo viejo ignora las columnas nuevas.

CREATE TABLE IF NOT EXISTS "quick_reply" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shortcut" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "assigned_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quick_reply" ADD CONSTRAINT "quick_reply_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quick_reply" ADD CONSTRAINT "quick_reply_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quick_reply_org_shortcut_uq" ON "quick_reply" USING btree ("organization_id","shortcut");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quick_reply_org_pos_idx" ON "quick_reply" USING btree ("organization_id","position");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_org_assignee_idx" ON "conversation" USING btree ("organization_id","assigned_user_id");
