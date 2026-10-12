-- Tareas 02 (métricas del agente) y 05 (alertas): contrato conjunto 05/02-0.
--
--   message_org_created_idx     (organization_id, created_at) — barrido por
--                               rango de fechas de toda la org (Reportes)
--   conversation_handoff_event  bitácora APPEND-ONLY de escalamientos a humano:
--                               una fila "opened" por cada transición de
--                               conversation.handoff_at de NULL a una fecha.
--                               La única puerta que inserta es markHandoff
--                               (src/server/inbox/handoff.ts); nadie actualiza
--                               ni borra. created_at ES la hora del evento.
--   hoe_org_created_idx         eventos por periodo
--   hoe_org_reason_idx          eventos por motivo
--
-- Siembra (al final): una fila "opened" aproximada por cada conversación que
-- HOY tiene handoff abierto y no es del Laboratorio, con
-- created_at = handoff_at, source = 'migracion', approximate = true (cuenta
-- para totales, jamás para promedios de tiempo). El id es determinista
-- ('hoe_seed_' || conversation.id) y ON CONFLICT DO NOTHING: re-ejecutar no
-- duplica.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en tabla e índices, y DO-block en cada clave foránea.
-- Los REFERENCES van sin calificar el esquema (ver scripts/migrate.mjs).
-- Sin CONCURRENTLY: scripts/migrate.mjs corre todo en una transacción (el
-- índice de message bloquea escrituras unos segundos durante el deploy).

CREATE TABLE IF NOT EXISTS "conversation_handoff_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"note" text,
	"source" text NOT NULL,
	"actor_user_id" text,
	"approximate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_handoff_event" ADD CONSTRAINT "conversation_handoff_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_handoff_event" ADD CONSTRAINT "conversation_handoff_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_handoff_event" ADD CONSTRAINT "conversation_handoff_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hoe_org_created_idx" ON "conversation_handoff_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hoe_org_reason_idx" ON "conversation_handoff_event" USING btree ("organization_id","reason");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_org_created_idx" ON "message" USING btree ("organization_id","created_at");--> statement-breakpoint
INSERT INTO "conversation_handoff_event"
	("id", "organization_id", "conversation_id", "kind", "reason", "note", "source", "actor_user_id", "approximate", "created_at")
SELECT 'hoe_seed_' || c."id", c."organization_id", c."id", 'opened', c."handoff_reason",
	c."handoff_note", 'migracion', NULL, true, c."handoff_at"
FROM "conversation" c
WHERE c."handoff_at" IS NOT NULL AND c."is_test" = false
ON CONFLICT ("id") DO NOTHING;
