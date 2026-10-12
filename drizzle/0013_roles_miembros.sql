-- Tarea 00 (roles y permisos): una membresía por persona y organización.
--
-- Hasta aquí `member` no tenía índice único y el alta de equipo hacía
-- `onConflictDoNothing()` sin conflicto que detectar, así que pudieron quedar
-- membresías duplicadas. El rol NO se reescribe (se conserva `member`; la
-- normalización de valores raros vive en código, src/lib/roles.ts).
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitucion IV):
-- el DELETE no borra nada la segunda vez y el índice lleva IF NOT EXISTS.
-- Sin FKs, asi que no hay esquema que desqualificar (ver scripts/migrate.mjs).

-- 1) Deduplicar: por (organización, usuario) se conserva una sola fila, la de
--    mayor privilegio (owner primero) y, a igualdad, la más antigua (id como
--    desempate estable). Toda fila "mayor" que otra del mismo par se borra.
DELETE FROM "member" m
 USING "member" d
 WHERE m."organization_id" = d."organization_id"
   AND m."user_id" = d."user_id"
   AND (CASE WHEN m."role" = 'owner' THEN 0 ELSE 1 END, m."created_at", m."id")
     > (CASE WHEN d."role" = 'owner' THEN 0 ELSE 1 END, d."created_at", d."id");
--> statement-breakpoint
-- 2) La unicidad que el alta de equipo ya asumía (ON CONFLICT contra ella).
CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_uq" ON "member" USING btree ("organization_id","user_id");
