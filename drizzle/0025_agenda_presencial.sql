-- 023 Agenda presencial (tipos de cita, vendedores y choques).
--
--   appointment_type                 catálogo de tipos por org (nombre,
--                                    duración, exclusivo, orden, activo);
--                                    seed_key marca la siembra perezosa.
--   appointment_type_org_seed_uq     UNIQUE (org, seed_key): siembra
--                                    idempotente aunque dos requests la
--                                    disparen a la vez.
--   booking.appointment_type_id      tipo de la cita (NULL en bloqueos y en
--                                    citas de la 015).
--   booking.assigned_user_id         el vendedor (NULL = sin asignar).
--   booking.created_by_user_id       quien la creó (visibilidad del Vendedor).
--   booking.exclusive                copia de appointment_type.exclusive.
--   offered_slot.appointment_type_id el tipo ofrecido a la conversación.
--   calendar_settings.address        dirección del negocio.
--
--   DROP booking_org_active_slot_uq  impedía a dos vendedores coincidir. La
--                                    agenda nunca se encendió en producción.
--   booking_type_exclusive_slot_uq   mismo tipo exclusivo, mismo instante.
--   booking_seller_slot_uq           mismo vendedor, mismo instante.
--   booking_org_assignee_idx         visibilidad por vendedor.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla, columnas e índices, DROP INDEX IF EXISTS y DO-blocks
-- en las claves foráneas. Los REFERENCES van sin calificar el esquema (ver
-- scripts/migrate.mjs).
--
-- Se aplica igual con la bandera AGENDA apagada (ADR-001): tablas y columnas
-- vacías son inertes.

CREATE TABLE IF NOT EXISTS "appointment_type" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"seed_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "booking_org_active_slot_uq";--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "appointment_type_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "assigned_user_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "exclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "appointment_type_id" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "appointment_type" ADD CONSTRAINT "appointment_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_type_org_seed_uq" ON "appointment_type" USING btree ("organization_id","seed_key");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_appointment_type_id_appointment_type_id_fk" FOREIGN KEY ("appointment_type_id") REFERENCES "appointment_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "offered_slot" ADD CONSTRAINT "offered_slot_appointment_type_id_appointment_type_id_fk" FOREIGN KEY ("appointment_type_id") REFERENCES "appointment_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_type_exclusive_slot_uq" ON "booking" USING btree ("organization_id","appointment_type_id","scheduled_at") WHERE "booking"."exclusive" and "booking"."status" in ('agendada','realizada') and "booking"."is_test" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_seller_slot_uq" ON "booking" USING btree ("organization_id","assigned_user_id","scheduled_at") WHERE "booking"."assigned_user_id" is not null and "booking"."kind" = 'session' and "booking"."status" in ('agendada','realizada') and "booking"."is_test" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_org_assignee_idx" ON "booking" USING btree ("organization_id","assigned_user_id");
