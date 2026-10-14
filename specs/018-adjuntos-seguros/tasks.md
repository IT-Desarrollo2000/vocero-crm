# 018 — Tareas

Estado durable del loop. `[x]` = hecho y verificado.

## Bloque 1 — Núcleo de seguridad y caché (WhatsApp)
- [x] T001 `src/server/media/file-policy.ts`: detección por firma, lista blanca, bloqueos con razón, escaneo ZIP (central directory) para OOXML/macros, texto UTF-8, PDF JS best-effort + tests unitarios
- [x] T002 Migración 0020: `media_asset.direction` (backfill) + `source_url`; `fetch_status` + `expired|blocked`
- [x] T003 `capabilities.ts`: `outboundFiles` (matriz por canal) + `outboundStructured`; DTO y tipos
- [x] T004 Envío: validación tope → firma → canal (`send.ts`, ruta `messages/media`); csv → text/plain en WA; asset con MIME detectado y `direction=out`
- [x] T005 Entrante WA: verificar firma tras descargar; bloqueado → no guardar
- [x] T006 `GET /api/media/[assetId]` y `/api/bot/media/[mediaId]`: cabeceras seguras, content-type detectado, inline/attachment, 415/410
- [x] T007 Reloj de purga 30 días + `POST /api/dev/media/purge` (dev) + permisos; favicon intacto
- [x] T008 wa-mock: bytes JPEG/PDF reales; variantes `exe`/`html`
- [x] T009 Prueba unitaria: el agente IA no envía archivos

## Bloque 2 — Messenger e Instagram
- [x] T020 Entrantes: `attachments[]` en Messenger e IG (Meta) + `source_url` + descarga con lista de hosts; no soportados → marcador; Zernio → marcador
- [x] T021 Salida Messenger multipart `filedata`
- [x] T022 Salida Instagram por URL firmada + `GET /api/media/out/[token]` (público) + permisos
- [x] T023 Mocks: `channel-inbound` con `attachments`, CDN mock, graph mock acepta multipart de Messenger y **descarga** la URL de IG

## Bloque 3 — UI, E2E y cierre
- [x] T030 Compositor: clip por `outboundFiles`, `accept`, aviso 30 días; estructurados por `outboundStructured`
- [x] T031 Hilo: bloqueado / expirado / error de carga; documentos como tarjeta
- [x] T032 Marcadores del agente: bloqueado / no soportado
- [x] T033 `scripts/e2e-selftest.mjs` + `tests/e2e/us-adjuntos.md` (AC-1…AC-8); actualizar asserts viejos (008, canales)
- [x] T034 Docs: `docs/canales-instagram-messenger.md`, `.env.example` (`MEDIA_RETENTION_DAYS`), spec 003 AC-3, CLAUDE.md mapa
- [x] T035 Gates: typecheck + lint + build + test + E2E encendido y apagado
- [x] T036 Revisión del advisor antes de declarar hecho
