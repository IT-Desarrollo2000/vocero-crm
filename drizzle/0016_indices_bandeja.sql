-- Tarea 06 (paginación de la Bandeja): índice de orden para el keyset.
--
--   conversation_org_sort_idx  (organization_id,
--                               coalesce(last_message_at, created_at) DESC,
--                               id DESC)
--
-- Sirve al ORDER BY de la lista paginada y al keyset
-- `(coalesce(last_message_at, created_at), id) < (cursor)`. El texto de las
-- expresiones es IDÉNTICO al de la consulta (DESC sin NULLS LAST): si
-- difieren, Postgres no usa el índice para ordenar.
--
-- NO es parcial (`WHERE is_test = false`) a propósito: la consulta envía
-- `is_test = false` como parámetro y un plan genérico de sentencia preparada
-- no puede probar el predicado de un índice parcial.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS. Sin CONCURRENTLY: scripts/migrate.mjs corre todo en una
-- transacción (bloquea escrituras de conversation unos segundos al deploy).

CREATE INDEX IF NOT EXISTS "conversation_org_sort_idx" ON "conversation" USING btree ("organization_id",(coalesce("last_message_at", "created_at")) DESC,"id" DESC);
