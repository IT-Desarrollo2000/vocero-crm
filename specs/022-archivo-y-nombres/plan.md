# 022 — Plan técnico

Spec: [spec.md](spec.md). Rama `022-archivo-y-nombres` (worktree
`vocero-crm-022`, desde `origin/main` 4a6d5c6).

## 1. Modelo (migración 0023 `archivo_y_nombres`)

- `contact.profile_name text NULL`. Backfill: `profile_name = name` cuando el
  nombre tiene letras y no es de relleno (`Contacto de …`).
- `conversation.archived_at timestamp NULL`, `archived_reason text NULL`
  (`manual | bulk | auto`), `archived_by text NULL` (FK `user.id` on delete
  set null). Índice `conversation_org_archived_idx (organization_id, archived_at)`.
- `pipeline_stage.keep_active boolean NOT NULL DEFAULT false` ("No archivar").
- Tabla `inbox_settings` (PK `organization_id` FK org cascade,
  `auto_archive_enabled bool NOT NULL DEFAULT false`, `auto_archive_days int
  NOT NULL DEFAULT 14`, `updated_at`). Sin fila = defaults.
- SQL re-ejecutable (`IF NOT EXISTS`), sin `"public".` (guard de migraciones).

## 2. Nombre de perfil (B)

- `identity.ts`: WA → en cada entrante con `profileName` no vacío y distinto,
  `patch.profileName`. Alta (3 canales) → `profileName` si vino.
  `isFallbackName` reconoce `Contacto de (WhatsApp|Instagram|Messenger)`.
- `channels/profile.ts`: cuando ya consulta Graph y obtiene nombre, guarda
  también `profile_name`. Zernio: `sender.name` en cada entrante.
- DTOs: `ConversationDto.contact.profileName`, `ContactDto.profileName`.
- Búsqueda: `contactSearchSql` y espejo `matchesQuery` (`src/lib/search.ts`)
  incluyen `profile_name`; `search-parity.test.ts` lo cubre.
- `PATCH /api/contacts/[id]`: tras cambiar `name`, publica
  `conversation.updated` por cada conversación real del contacto.
- UI: `contact-panel.tsx` edición en línea del nombre + línea gris
  "<Canal>: «nick»"; `contacts-client.tsx` muestra la línea gris.

## 3. Archivo (A)

### Servidor
- `src/server/inbox/archive.ts` (nuevo):
  - `UNARCHIVE_SET` = `{archivedAt: null, archivedReason: null, archivedBy: null}`
    para mezclar en los UPDATE de entrante/saliente.
  - `inactiveArchivableCondition(orgId, cutoff)` — inactiva ∧ no archivada ∧
    no test ∧ sin excepciones (NOT EXISTS booking agendada futura por
    conversación o contacto; NOT EXISTS lead→stage keep_active; NOT
    handoff_at > cutoff). Compartida por masiva, auto y preview.
  - `archiveInactive(orgId, {days, reason, by, dryRun, now})` → `{count}`.
  - `runAutoArchive(now)` recorre `inbox_settings` habilitadas.
- Desarchivar en: `ingestInboundMessage` (UPDATE de `ingest.ts`),
  `registrarOrigenSinMensaje`, eco WA, `persistOutbound` (solo si
  `status !== "failed"`), `sendTemplate`. Lab/`is_test` no aplica.
- `PATCH /api/conversations/[id]` acepta `archived: boolean` (`any*`, con
  visibilidad); `updateConversation` setea motivo `manual` + `archived_by`.
- Bandeja:
  - `InboxFilter`/`INBOX_FILTERS`/`InboxView`/`INBOX_VIEWS` + `"archived"`
    (`parseView` valida contra `INBOX_FILTERS`: agregar en ambos).
  - Regla: `archived_at IS NULL` salvo vista `archived` (→ `IS NOT NULL`) o
    `q` no vacío (incluye ambas). Capa aparte del switch de vistas, en
    `inboxListWhere` y en `base` de `countConversations`.
  - `ConversationCounts.archived`; badges `unreadConversations/Messages`
    excluyen archivadas.
  - `ConversationDto.archivedAt/archivedReason`.
- Ajustes: `GET/PUT /api/settings/inbox` (owner) → `{autoArchiveEnabled,
  autoArchiveDays}`. `POST /api/conversations/archive-inactive` (owner)
  `{days, dryRun}` → `{count}`.
- Etapas: `PATCH /api/pipeline/stages/[id]` acepta `keepActive` (owner);
  `StageDto.keepActive`.
- Eventos: operaciones masivas (bulk/auto) publican un solo evento
  `conversations.bulk` (sin ids) → el cliente recarga lista + contadores.
- Ticker `src/server/inbox/auto-archive-ticker.ts` clon de `purge-ticker`
  (`INBOX_AUTO_ARCHIVE_TICK_MS`, default 1 h, `0` apaga, mín. 60 s) arrancado
  en `instrumentation-node.ts`. Dev: `POST /api/dev/inbox/auto-archive
  {advanceDays?}` con `mockGuard()`.
- `ROUTE_POLICY`: las 4 rutas nuevas clasificadas.

### Cliente
- `list-state.ts` (`VIEWS`, `matchesFilters`, `countsFromLoaded`) y
  `helpers.ts` (`filterConversations`) replican la regla.
- `conversation-list.tsx`: pastilla **Archivadas**, botón icono archivar en
  la fila (hover/focus), etiqueta "Archivada" en resultados de búsqueda,
  vacío propio.
- `inbox-client.tsx`: botón Archivar/Desarchivar en la cabecera; aviso en el
  hilo; manejo del evento `conversations.bulk`.
- `settings/(owner)/inbox` + `src/components/settings/inbox-settings-client.tsx`
  + pestaña "Bandeja" en `settings-tabs.ts`.
- `stage-manager.tsx`: casilla "No archivar" por etapa.

## 3b. Ajustes tras revisión del asesor (Fable, 19-oct) — OBLIGATORIOS

1. **Contadores**: dos bases. `inboxFilterCondition("archived")` = `archived_at
   IS NOT NULL`; la capa `archived_at IS NULL` se añade SOLO si `view !==
   "archived" && !q` (lista y cada faceta de `countConversations`). El
   contador `archived` = base-cualquiera ∧ IS NOT NULL ∧ facetas.
   `unreadConversations/unreadMessages` (badge del menú) excluyen archivadas.
2. **Espejo cliente**: `displayedConversations` (`list-state.ts:328-334`)
   re-aplica el espejo con `q: ""`; decidir `includeArchived` con los filtros
   ORIGINALES (opción explícita a `filterConversations`), o la búsqueda tirará
   las archivadas que devolvió el servidor.
3. **Evento `conversations.bulk`** en tres sitios: `decideDelivery`
   (`events/visibility.ts:97-99`, `deliver` para todos), `SSE_EVENT_TYPES` +
   `HANDLER_FOR` (`src/lib/event-hub.ts`), `EventHandlers`
   (`src/components/use-events.ts`). Handler → `reloadList()` (`loadFirst`),
   NO `catchUp()` (`mergeFirstPage` conserva filas viejas).
4. `registrarOrigenSinMensaje` no hace UPDATE: añadir uno explícito para
   desarchivar.
5. Fallo asíncrono de WA (`pending` → `failed` por webhook) deja desarchivada:
   aceptado y documentado.
6. Cortes de tiempo calculados en Node (`now`, `cutoff`) y pasados como
   parámetros (convención `queries.ts:89-102`); nunca `now()` SQL.
7. **Backfill de `profile_name` solo en `channel = 'whatsapp'`** (IG/FB no
   re-consultan Graph si el nombre no es de relleno → un nombre ya editado
   quedaría como nick falso). NULL = desconocido.
8. Índice parcial `WHERE archived_at IS NOT NULL`.
9. `updateConversation` con `archived` filtra `is_test = false` y sube
   `updated_at` (también bulk/auto, para el modo `since`).
10. Dev endpoint pasa por `runAutoArchive` (respeta el interruptor); try/catch
    por organización como `reminders.ts:358-371`.
11. Excepción booking: `is_test = false`, `status='agendada'`, misma org,
    `scheduled_at > now`, `conversation_id = c.id OR contact_id = c.contact_id`.
    Lead por `contact_id` (≤1, `lead_contact_uq`). FK `archived_by` declarada
    en Drizzle como `assigned_user_id`.
12. Vendedor: API owner → 403; página `(owner)` → `requireOwnerPage`.
13. E2E: `wa-mock/inbound` acepta `timestamp` (epoch s) para fabricar
    antigüedad; `?contact=`/`?ids=` son loose (muestran archivadas): la fila
    lleva etiqueta "Archivada" siempre que `archivedAt` esté presente.

## 4. Verificación
- Unit: regla de vistas (SQL + espejo), condición archivable, ticker,
  identity/profile, search parity, role-matrix.
- E2E API (`scripts/e2e-selftest.mjs` → `archivoChecks`, `nombrePerfilChecks`).
- E2E UI Playwright `scripts/e2e-archivo-ui.mjs` (renombrar en panel,
  archivar desde cabecera, vista Archivadas, entrante desarchiva, ajustes y
  limpieza con conteo, Vendedor sin acceso).
- Guiones `tests/e2e/us-archivo.md`, `tests/e2e/us-nombre-contacto.md`.
- BD aislada Docker :5433 + `.env.e2e`; `CATALOG_STORAGE=local` explícito.
