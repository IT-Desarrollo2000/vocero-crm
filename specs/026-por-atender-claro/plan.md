# 026 — plan

Spec: [spec.md](spec.md).

## Datos — migración `drizzle/0027_por_atender_claro.sql` (re-ejecutable)

```sql
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS awaiting_since timestamp;
ALTER TABLE inbox_settings ADD COLUMN IF NOT EXISTS overdue_minutes integer NOT NULL DEFAULT 60;
```

Backfill (solo filas con `awaiting_since IS NULL`; idempotente):
- `h` = último saliente que atiende (`direction='out'`, `status<>'failed'`,
  `origin IN ('operator','manual','template','ai')`).
- Sin escalamiento abierto: `awaiting_since` = primer entrante posterior a
  `h` (NULL si no hay).
- Con escalamiento abierto (`handoff_at IS NOT NULL`):
  - `h'` = último saliente HUMANO (`operator`,`manual`,`template`) posterior
    a `handoff_at`; si existe → primer entrante posterior a `h'`;
  - si no existe → `handoff_at` (salvo `handoff_reason='manual_reply'`, que
    ya es respuesta humana → primer entrante posterior a `h`).

`schema.ts`: `conversation.awaitingSince`, `inboxSettings.overdueMinutes`
(+ snapshot/journal con `pnpm db:generate`, ajustando el SQL a mano como en
migraciones previas).

## Escrituras de `awaiting_since`

| Punto | Cambio |
|---|---|
| `ingestInboundMessage` (`src/server/inbox/ingest.ts` ~590) | `awaitingSince = coalesce(awaiting_since, waTimestamp)` |
| Leads externos (`src/server/intake/ingest.ts`) | idem con su instante |
| Laboratorio (`src/server/lab/runner.ts`) | sin cambio (conversaciones `is_test`, fuera de la Bandeja) |
| `persistOutbound` (`send.ts` ~437) | si `status !== 'failed'` → `awaitingSince = null` (operador, IA y bot externo atienden) |
| `sendTemplate` (`src/server/whatsapp/templates.ts`) | nueva opción `attends` (default `true`); `reminders.ts` pasa `false` |
| `ingestManualEcho` (`ingest.ts` ~357) | `awaitingSince = null` |
| `markHandoff` (`handoff.ts`) | si `reason !== 'manual_reply'`: `awaitingSince = coalesce(awaiting_since, now)` |
| `updateConversation` (`queries.ts` ~689) | nuevo patch `attended: true` (+ `aiEnabled`): `awaitingSince=null`, `handoff*=null`, `aiEnabled = patch.aiEnabled ?? false`. `reactivate` sin cambio |
| `bot/reset` | `awaitingSince = null` |

## Lectura

- `serializeConversation` → `ConversationDto.awaitingSince: string | null`.
- `inboxFilterCondition("human")` → `and(or(handoff_at not null, ai_enabled=false), awaiting_since not null)`.
- Espejo cliente: `helpers.ts` — `needsHuman` se queda; nueva `isAwaiting(c)`
  = `needsHuman(c) && c.awaitingSince != null`; `filterConversations` y
  `list-state.ts` (conteo de respaldo) usan `isAwaiting` para `human`.
- Umbral al cliente: `InboxPage` (server) lee `overdueMinutes` de la
  organización de la sesión (`getInboxSettings`) y lo pasa a `InboxClient`
  → `ConversationList` / `ContactPanel`. Sin sesión/fila → 60.

## UI

- `src/lib/awaiting.ts` (puro, testeable): `awaitingState(c, now, overdueMin)`
  → `{ kind: 'none' } | { kind: 'waiting', ms, overdue } | { kind: 'attended' }`
  y `formatWait(ms)` ("3 min", "1 h 20 min", "2 d").
- Fila (`conversation-list.tsx` ~922): reemplaza "Por atender"/"IA pausada"
  por "Esperando · X" (ámbar `warning-*`; rojo con los tokens de error) o
  "Atendida" (neutra, `Check`). `title` con hora de inicio / "IA en pausa".
- Panel (`contact-panel.tsx` ~446): tarjeta de escalamiento retitulada
  "Escalada a una persona" (motivo + nota); línea de estado "Esperando
  respuesta · X" / "Atendida"; botón "Marcar como atendida" (si espera o
  escalamiento abiertos) que despliega dos opciones: "Seguir atendiendo yo" /
  "Devolver a la IA". "Reactivar IA" sigue.
- Ajustes → Bandeja: campo numérico de minutos (5–1440) en la misma tarjeta
  de ajustes; `inboxSettingsSchema` + `InboxSettingsDto` + `saveInboxSettings`.
- Texto vacío de la vista: "Nadie está esperando respuesta."

## API

- `PATCH /api/conversations/[id]`: `patchSchema` acepta `attended?: true`.
  Misma guarda y permisos que hoy (la ruta ya está en la matriz).
- `PUT /api/settings/inbox`: `overdueMinutes` (requerido en el schema con
  default para clientes viejos: `.default(60)`).

## Pruebas

- Unit: `awaiting.ts` (estados, formato, umbral); filtro `human` (SQL y
  espejo cliente); `updateConversation` `attended`; schema de ajustes.
- E2E: `async function porAtenderChecks()` en `scripts/e2e-selftest.mjs`
  (CA-1…CA-9 vía API + wa-mock inbound/echo + ai-mock) y guion
  `tests/e2e/us-por-atender.md`; verificación visual con Playwright de la
  fila y el panel (etiquetas, botón, color rojo con umbral bajo).

## Ajustes tras la revisión Fable del plan (21-oct)

- **Carrera entrante/saliente**: la limpieza NO es incondicional. Se captura
  `startedAt` al entrar a `sendText`/`sendMediaMessage`/`sendStructured`/
  `sendTemplate` y se escribe
  `awaiting_since = CASE WHEN last_inbound_at > startedAt THEN coalesce(awaiting_since, last_inbound_at) ELSE NULL END`.
  En `ingestManualEcho` la cota es el `waTimestamp` del eco.
- **Backfill solo una vez**: DO-block que mira `information_schema.columns`;
  si `conversation.awaiting_since` no existía, la crea Y hace el backfill; si
  ya existía, no toca datos (no reabre las cerradas a mano). Excluye
  `is_test`. Rama con escalamiento abierto sin respuesta humana posterior:
  `coalesce(primer entrante posterior a h, handoff_at)`; `manual_reply` →
  primer entrante posterior a `h`.
- **`reactivate` también limpia la espera** ("Reactivar IA" ≡ "Devolver a la
  IA"). `attended` y `reactivate` juntos → 400 (`.refine`).
- **Lead externo**: la espera arranca en `now()` (no en la fecha del lead).
- **pending → failed por webhook**: se acepta limpiar al insertar (misma
  convención que el desarchivo 022). Riesgo documentado.
- **Umbral**: `InboxPage` usa `getSessionOrNull()` como `(app)/layout.tsx` y
  lee `getInboxSettings(org)`; NO se pide `/api/settings/inbox` desde el
  cliente (owner-only). El cambio se ve al recargar/navegar (sin SSE).
- **Reloj**: se reutiliza el `now` existente de la lista.
- **E2E/tests existentes a actualizar**: `scripts/e2e-bandeja-paginacion.mjs`
  (~319-328), `scripts/e2e-search-filters.mjs` (~283-335),
  `tests/unit/inbox-filters.test.ts`, `tests/unit/inbox-list.test.ts`.
- Sin índice nuevo.

## Riesgos
- "Marcar como atendida" sin mensaje cuenta como `sin_respuesta` en el
  reporte de tiempos tras handoff (mide mensajes). Aceptado.
- Instancias con el agente apagado y `ai_enabled=true`: esos chats no entran
  a "Por atender" (comportamiento actual, no regresión).
- `persistOutbound` también corre con `failed`: la limpieza va condicionada.
- Recordatorio = plantilla: se distingue solo por la opción `attends`.
- La vista cambia de significado: chats con IA en pausa ya contestados dejan
  de aparecer en "Por atender" (es lo pedido).
