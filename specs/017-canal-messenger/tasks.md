# 017 — Tareas

Estado durable del loop. `[x]` = hecho y verificado.

## Entorno
- [x] T001 Postgres local aislado (Docker, puerto 5433) + `.env.e2e` (gitignored); línea base E2E 150/150

## Núcleo de canales
- [x] T010 `messenger` en `lib/channels.ts` + enum TS en `schema.ts`
- [x] T011 Tabla `messenger_credentials` + migración 0011 (`pnpm db:generate`)
- [x] T012 Capacidades: `humanAgentWindowMs` (7 d), `maxTextChars`, `templates`; `replyModeFor()`
- [x] T013 `identity.ts`: prefijo `fb:` y rama genérica para canales ≠ WhatsApp
- [x] T014 `send.ts`: ruteo por canal (tabla de transportes), 7 días, errores por canal; media/estructurados/plantillas → error claro fuera de WhatsApp
- [x] T015 DTO `replyMode` + compositor por canal (sin plantillas/adjuntos donde no aplica)

## Messenger
- [x] T020 `src/server/messenger/{credentials,ingest,send}.ts`
- [x] T021 Webhook `/api/webhooks/fb/[webhookToken]` (GET handshake, POST firmado)
- [x] T022 `/api/settings/messenger` GET/PUT/DELETE con verificación contra Graph
- [x] T023 Glifo en `channel-badge`

## Instagram
- [x] T030 `IG_APP_SECRET` (fallback `META_APP_SECRET`) en el webhook de IG
- [x] T031 DELETE en `/api/settings/instagram`

## UI
- [x] T040 Pantallas `/settings/instagram` y `/settings/messenger` + pestañas por bandera

## Mocks + E2E
- [x] T050 wa-mock graph: `GET me` / `GET {pageId}` con id derivado del token, outbox con `recipient.id`/tag/canal, error de permiso de etiqueta
- [x] T051 Ruta dev `channel-inbound` (payload estilo Messenger firmado → `/ig` o `/fb`)
- [x] T052 `channelChecks()` en `scripts/e2e-selftest.mjs` + `tests/e2e/us-canales.md`

## Cierre
- [x] T060 Tests unitarios (capacidades, replyMode, parseo de payloads)
- [x] T061 CI matrix `completo` con messenger; `.env.example` / `.env.agenciaev.example` / compose
- [x] T062 `docs/canales-instagram-messenger.md` (setup en Meta de ambos canales)
- [x] T063 Gates: typecheck + lint + build + test + E2E (encendido y apagado)
- [x] T064 Revisión del advisor antes de declarar hecho

## Evidencia (2026-09-30)
- E2E BD limpia, `CHANNELS=whatsapp,instagram,messenger` + AGENDA + ATRIBUCION: **231/231**
- E2E BD limpia, todo apagado: **109/109** (superficies de IG/FB → 404)
- `pnpm test` 381/381 · typecheck · lint · build verdes
- Recorrido en navegador (Playwright + Edge): pestañas por bandera, compositor
  libre / agente humano / cerrado sin plantillas ni adjuntos, 0 errores de consola

## Pendiente fuera del código
- Aplicar la migración 0011 en la BD Supabase (`vocero`) — espera OK del dueño
- Credenciales reales: tras verificación de negocio + App Review (Human Agent)
