-- 026 "Por atender" que dice la verdad (esperando vs. atendida).
--
--   conversation.awaiting_since    desde cuándo el cliente espera respuesta.
--                                  NULL = nadie le debe respuesta. Lo fija el
--                                  primer entrante sin contestar (o el
--                                  escalamiento); lo limpia un saliente que
--                                  atiende, "Marcar como atendida" o
--                                  "Reactivar IA".
--   inbox_settings.overdue_minutes umbral de "atrasada" (5–1440, default 60).
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV):
-- IF NOT EXISTS en el umbral y un DO-block para la espera.
--
-- Backfill SOLO la primera vez: el DO-block mira `information_schema` (en el
-- esquema actual: en Supabase Vocero vive en `vocero`, no en `public`); si la
-- columna no existía, la crea y la siembra en la misma transacción. Si ya
-- existía no toca datos: re-ejecutar no reabre las que se cerraron a mano.
-- Las del Laboratorio (`is_test`) quedan en NULL.
--
-- Instante de un mensaje = coalesce(wa_timestamp, created_at), la misma regla
-- que `serializeMessage`. Saliente que atiende (h) = `direction='out'`,
-- `status<>'failed'`, origin operator/manual/template/ai (el recordatorio
-- también es `template`: el pasado no los distingue, aceptado).
--   - Sin escalamiento abierto: primer entrante posterior a h (NULL si no hay).
--   - Escalamiento abierto (`handoff_at` NOT NULL):
--       · `manual_reply` (eco del teléfono = ya hubo respuesta humana):
--         primer entrante posterior a h;
--       · con un saliente HUMANO (operator/manual/template) posterior al
--         escalamiento (h'): primer entrante posterior a h';
--       · sin él: coalesce(primer entrante posterior a h, handoff_at).

ALTER TABLE "inbox_settings" ADD COLUMN IF NOT EXISTS "overdue_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = 'conversation'
			AND column_name = 'awaiting_since'
	) THEN
		ALTER TABLE "conversation" ADD COLUMN "awaiting_since" timestamp;

		WITH h AS (
			SELECT c.id,
				c.organization_id,
				c.handoff_at,
				c.handoff_reason,
				(SELECT max(coalesce(m.wa_timestamp, m.created_at)) FROM "message" m
					WHERE m.organization_id = c.organization_id
						AND m.conversation_id = c.id
						AND m.direction = 'out'
						AND m.status <> 'failed'
						AND m.origin IN ('operator', 'manual', 'template', 'ai')) AS last_attend,
				(SELECT max(coalesce(m.wa_timestamp, m.created_at)) FROM "message" m
					WHERE m.organization_id = c.organization_id
						AND m.conversation_id = c.id
						AND m.direction = 'out'
						AND m.status <> 'failed'
						AND m.origin IN ('operator', 'manual', 'template')
						AND coalesce(m.wa_timestamp, m.created_at) > c.handoff_at) AS last_human
			FROM "conversation" c
			WHERE c.is_test = false
		),
		f AS (
			SELECT h.id,
				h.organization_id,
				h.handoff_at,
				h.handoff_reason,
				h.last_human,
				(SELECT min(coalesce(m.wa_timestamp, m.created_at)) FROM "message" m
					WHERE m.organization_id = h.organization_id
						AND m.conversation_id = h.id
						AND m.direction = 'in'
						AND (h.last_attend IS NULL
							OR coalesce(m.wa_timestamp, m.created_at) > h.last_attend)) AS first_in_after_attend,
				(SELECT min(coalesce(m.wa_timestamp, m.created_at)) FROM "message" m
					WHERE m.organization_id = h.organization_id
						AND m.conversation_id = h.id
						AND m.direction = 'in'
						AND h.last_human IS NOT NULL
						AND coalesce(m.wa_timestamp, m.created_at) > h.last_human) AS first_in_after_human
			FROM h
		),
		v AS (
			SELECT f.id, CASE
				WHEN f.handoff_at IS NULL THEN f.first_in_after_attend
				WHEN f.handoff_reason = 'manual_reply' THEN f.first_in_after_attend
				WHEN f.last_human IS NOT NULL THEN f.first_in_after_human
				ELSE coalesce(f.first_in_after_attend, f.handoff_at)
			END AS awaiting
			FROM f
		)
		-- Solo las filas que quedan esperando: no bloquear toda la tabla
		-- mientras el contenedor anterior sigue atendiendo webhooks.
		UPDATE "conversation" c
		SET "awaiting_since" = v.awaiting
		FROM v
		WHERE c.id = v.id
			AND v.awaiting IS NOT NULL
			AND c."awaiting_since" IS NULL;
	END IF;
END $$;
