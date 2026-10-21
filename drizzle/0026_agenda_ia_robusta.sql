-- 025 Agenda por IA robusta (día pedido, reservar por clave local, trato).
--
--   agent_profile.formality   trato con el cliente: 'tu' (default) o
--                             'usted'. Lo respetan el prompt, los textos del
--                             motor de agenda y los respaldos de
--                             recordatorios.
--   message.agent_action      la acción de agenda que produjo un saliente
--                             del motor ({action:"offer_slots", type, date,
--                             part, shown} o {action:"book_slot", booked}).
--                             El historial del agente la presenta como esa
--                             acción, no como un reply con horas. NULL en
--                             todo lo demás.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en las columnas.
--
-- Se aplica igual con la bandera AGENDA apagada (ADR-001): una columna con
-- default y otra NULL son inertes.

ALTER TABLE "agent_profile" ADD COLUMN IF NOT EXISTS "formality" text DEFAULT 'tu' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "agent_action" jsonb;
