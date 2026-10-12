-- Tarea 10 (recordatorio de citas y no-shows): contrato 10-0.
--
--   booking_reminder   una fila por (cita, anticipación, hora de la cita).
--                      UNIQUE (booking_id, offset_minutes, scheduled_for) es el
--                      claim atómico: INSERT … ON CONFLICT DO NOTHING RETURNING
--                      (a lo sumo un envío automático, D-10-02). claimed_at y
--                      sent_at los pone JS (reloj inyectable): claimed_at NO
--                      tiene default a propósito.
--   agenda_offer_log   bitácora APPEND-ONLY de rondas de horarios ofrecidos
--                      (D-10-07), denominador de "oferta → cita". Nadie
--                      actualiza ni borra.
--   calendar_settings  ajustes de recordatorio: reminder_enabled (apagado),
--                      reminder_enabled_at (solo se avisan recordatorios cuyo
--                      momento de envío sea >= esta fecha), plantilla,
--                      anticipaciones (1 o 2, minutos) y mapeo de variables.
--
-- Se aplica siempre, con AGENDA encendida o apagada (ADR-001): tablas vacías
-- y columnas con default son inertes.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tablas, columnas e índices, y DO-block en cada clave
-- foránea. Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).

CREATE TABLE IF NOT EXISTS "agenda_offer_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slot_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_reminder" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"booking_id" text NOT NULL,
	"offset_minutes" integer NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"error" text,
	"template_id" text,
	"message_id" text,
	"wa_message_id" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "reminder_enabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "reminder_template_id" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "reminder_offsets_minutes" jsonb DEFAULT '[1440]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "reminder_variables" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agenda_offer_log" ADD CONSTRAINT "agenda_offer_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agenda_offer_log" ADD CONSTRAINT "agenda_offer_log_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "template"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agenda_offer_log_org_created_idx" ON "agenda_offer_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agenda_offer_log_conv_idx" ON "agenda_offer_log" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_reminder_claim_uq" ON "booking_reminder" USING btree ("booking_id","offset_minutes","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_reminder_org_status_idx" ON "booking_reminder" USING btree ("organization_id","status","claimed_at");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_reminder_template_id_template_id_fk" FOREIGN KEY ("reminder_template_id") REFERENCES "template"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
