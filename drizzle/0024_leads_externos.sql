-- 011 Leads externos (formulario web y FastApp → POST /api/intake/lead).
--
--   intake_settings            una fila por org: clave de leads externos
--                              cifrada (AES-256-GCM, lib/crypto), sus últimos
--                              4 y la hora del último lead por origen.
--   intake_settings_org_uq     UNIQUE (organization_id): una clave por negocio.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla e índice, y DO-block en la clave foránea. Los
-- REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
--
-- Puramente ADITIVA: la tabla existe aunque la bandera LEADS_EXTERNOS esté
-- apagada (ADR-001); sin fila = sin clave = la superficie responde 401/404.

CREATE TABLE IF NOT EXISTS "intake_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key_cipher" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_tag" text NOT NULL,
	"key_last4" text NOT NULL,
	"last_received_at" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "intake_settings" ADD CONSTRAINT "intake_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_settings_org_uq" ON "intake_settings" USING btree ("organization_id");
