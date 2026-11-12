-- 035 fase B — Avisos dentro del CRM (campana, aviso emergente, navegador).
--
--   notification                            un aviso para UNA persona:
--                                           recordatorio vencido, resumen del
--                                           día, «Te asignaron…» (chat o cita).
--   notification_org_user_dedupe_uq         clave determinista: el UNIQUE es
--                                           el candado (tick repetido, dos
--                                           réplicas o dos clics no duplican).
--   notification_org_user_read_created_idx  la campana y su contador.
--   notification_follow_up_idx              Hecho / posponer marcan leído el
--                                           aviso de ese recordatorio.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla e índices y DO-block en las claves foráneas. Los
-- REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Núcleo sin bandera: sin filas, la campana se ve vacía.

CREATE TABLE IF NOT EXISTS "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"follow_up_id" text,
	"conversation_id" text,
	"booking_id" text,
	"contact_id" text,
	"actor_user_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_follow_up_id_follow_up_id_fk" FOREIGN KEY ("follow_up_id") REFERENCES "follow_up"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_org_user_dedupe_uq" ON "notification" USING btree ("organization_id","user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_org_user_read_created_idx" ON "notification" USING btree ("organization_id","user_id","read_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_follow_up_idx" ON "notification" USING btree ("follow_up_id");
