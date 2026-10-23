-- 029 Respuestas rápidas del equipo.
--
--   inbox_settings.sellers_create_quick_replies  interruptor del Propietario
--                                                «Vendedores pueden crear
--                                                respuestas rápidas». Sin fila
--                                                (o fila vieja) = encendido.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en la columna.

ALTER TABLE "inbox_settings" ADD COLUMN IF NOT EXISTS "sellers_create_quick_replies" boolean DEFAULT true NOT NULL;
