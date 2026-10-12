-- Tarea 04 (el agente llena la ficha): definición de campos por organización,
-- procedencia por clave de la ficha, bitácora append-only de cambios y el
-- chequeo de llenado del Laboratorio.
--
--   agent_profile.ficha_fields  NULL = sin definición (ficha libre, como antes)
--   contact.ficha_meta          NULL = sin procedencia (dato anterior a 04)
--   ficha_event                 bitácora; solo la escribe src/server/bot/ficha.ts
--   agent_test_case.ficha_check { esperados, llenados, cumplidos } del Laboratorio
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitucion IV):
-- IF NOT EXISTS en tabla, columnas e indice, y DO-block en cada clave foranea.
-- Sin `"public".` en los REFERENCES (ver scripts/migrate.mjs).
--
-- Es puramente ADITIVA y NULLABLE, sin backfill: las filas existentes quedan
-- en NULL y el codigo viejo ignora las columnas nuevas.

CREATE TABLE IF NOT EXISTS "ficha_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"conversation_id" text,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"source" text NOT NULL,
	"actor_user_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN IF NOT EXISTS "ficha_fields" jsonb;--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD COLUMN IF NOT EXISTS "ficha_check" jsonb;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "ficha_meta" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ficha_event" ADD CONSTRAINT "ficha_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ficha_event" ADD CONSTRAINT "ficha_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ficha_event" ADD CONSTRAINT "ficha_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ficha_event" ADD CONSTRAINT "ficha_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ficha_event_org_contact_idx" ON "ficha_event" USING btree ("organization_id","contact_id","created_at");
