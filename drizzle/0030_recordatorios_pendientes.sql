-- 035 Recordatorios internos del vendedor («Recordarme», Seguimiento › Pendientes).
--
--   follow_up                           un recordatorio del vendedor sobre un
--                                       cliente; nunca sale del CRM (los de
--                                       cita al cliente son booking_reminder).
--   follow_up_repeat_months_ck          repetir: nada, 3, 6 o 12 meses.
--   follow_up_org_user_status_due_idx   Pendientes y el número rojo del menú.
--   follow_up_org_contact_status_idx    diálogo, cajón del trato y «ya tiene
--                                       recordatorio» en Sin contacto.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla e índices y DO-block en las claves foráneas. El CHECK
-- va dentro del CREATE TABLE (si la tabla ya existe, ya lo tiene). Los
-- REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Núcleo sin bandera: sin filas, Seguimiento se ve igual que antes.

CREATE TABLE IF NOT EXISTS "follow_up" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"conversation_id" text,
	"user_id" text NOT NULL,
	"due_at" timestamp NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"repeat_months" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"done_at" timestamp,
	"done_note" text,
	"created_from" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "follow_up_repeat_months_ck" CHECK ("follow_up"."repeat_months" IS NULL OR "follow_up"."repeat_months" IN (3, 6, 12))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follow_up_org_user_status_due_idx" ON "follow_up" USING btree ("organization_id","user_id","status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follow_up_org_contact_status_idx" ON "follow_up" USING btree ("organization_id","contact_id","status");
