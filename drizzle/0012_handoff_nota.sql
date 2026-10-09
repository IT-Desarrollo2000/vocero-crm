-- Nota libre del escalamiento: el porqué concreto que da quien escala (el
-- agente in-process o el cerebro externo), aparte del catálogo cerrado de
-- `handoff_reason`.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitucion IV):
-- IF NOT EXISTS en la columna. Es puramente ADITIVA y NULLABLE: las filas
-- existentes quedan en NULL y el codigo viejo la ignora. Sin FKs, asi que no
-- hay esquema que desqualificar (ver scripts/migrate.mjs).

ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "handoff_note" text;
