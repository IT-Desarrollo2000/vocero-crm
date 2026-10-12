-- Tarea 08 (Laboratorio por cliente): contrato 08-0.
--
--   lab_persona                 personas guionadas POR ORGANIZACIÓN. key es un
--                               slug estable (el juez y el ai-mock despachan
--                               por ella): UNIQUE (organization_id, key), aun
--                               con la persona archivada. phone es sintético
--                               (prefijo 52100000) y lo genera el servidor.
--                               seed_set = autos|neutro si nació de la semilla
--                               (D-08-01), NULL si es personalizada.
--   lab_suggestion_application  sugerencia del juez ya aplicada (KB o perfil).
--                               UNIQUE (test_case_id, hallazgo_index) es el
--                               candado de idempotencia: INSERT … ON CONFLICT
--                               DO NOTHING en la misma transacción que el
--                               efecto. Cae en cascada con el caso; la entrada
--                               del KB y el texto del perfil se quedan.
--   agent_test_run              config_snapshot (perfil + KB + personas +
--                               modelos al crear la corrida) y persona_keys
--                               (conjunto de la corrida, para el delta).
--   agent_test_case             persona_snapshot (la persona tal como corrió).
--
-- SIN siembra aquí: los guiones llevan apóstrofes y emoji, y el set depende de
-- si la organización ya tiene corridas (D-08-01). La siembra es perezosa y
-- vive en código (ensureSeedPersonas, src/server/lab/persona-store.ts).
-- Columnas nuevas NULL: las corridas anteriores siguen legibles.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tablas, columnas e índices, y DO-block en cada clave
-- foránea. Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).

CREATE TABLE IF NOT EXISTS "lab_persona" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"objetivo" text DEFAULT '' NOT NULL,
	"rasgos" text,
	"guion" jsonb NOT NULL,
	"criterios_exito" text,
	"contact_name" text NOT NULL,
	"phone" text NOT NULL,
	"seed" jsonb,
	"expect_ficha" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed_set" text,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lab_suggestion_application" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"test_case_id" text NOT NULL,
	"hallazgo_index" integer NOT NULL,
	"target" text NOT NULL,
	"field" text,
	"kb_entry_id" text,
	"applied_text" text NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_test_case" ADD COLUMN IF NOT EXISTS "persona_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_test_run" ADD COLUMN IF NOT EXISTS "config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_test_run" ADD COLUMN IF NOT EXISTS "persona_keys" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lab_persona" ADD CONSTRAINT "lab_persona_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lab_suggestion_application" ADD CONSTRAINT "lab_suggestion_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lab_suggestion_application" ADD CONSTRAINT "lab_suggestion_application_test_case_id_agent_test_case_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "agent_test_case"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lab_suggestion_application" ADD CONSTRAINT "lab_suggestion_application_kb_entry_id_kb_entry_id_fk" FOREIGN KEY ("kb_entry_id") REFERENCES "kb_entry"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lab_suggestion_application" ADD CONSTRAINT "lab_suggestion_application_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lab_persona_org_key_uq" ON "lab_persona" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lab_persona_org_pos_idx" ON "lab_persona" USING btree ("organization_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lab_suggestion_case_hallazgo_uq" ON "lab_suggestion_application" USING btree ("test_case_id","hallazgo_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lab_suggestion_org_idx" ON "lab_suggestion_application" USING btree ("organization_id");
