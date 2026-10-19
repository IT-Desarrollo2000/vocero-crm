# 022 — Archivo y nombres · tareas

Plan: [plan.md](plan.md). Rama `022-archivo-y-nombres` (worktree
`vocero-crm-022`). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Migración 0023
- [x] schema.ts: `contact.profile_name`, `conversation.archived_*`,
  `pipeline_stage.keep_active`, tabla `inbox_settings`.
- [x] `pnpm db:generate --name archivo_y_nombres`; SQL re-ejecutable + backfill.

## T2. Nombre de perfil (B)
- [x] identity.ts / channels/profile.ts / Zernio guardan `profile_name`.
- [x] `isFallbackName` cubre los 3 canales.
- [x] DTOs + búsqueda (server y espejo) con `profile_name`.
- [x] PATCH contacto publica `conversation.updated`.
- [x] Panel: edición en línea + línea gris; Contactos: línea gris.
- [x] Unit: identity, search-parity.

## T3. Archivo — servidor (A)
- [x] `src/server/inbox/archive.ts` (condición, masiva, auto).
- [x] Desarchivar en entrante / origen sin mensaje / eco / saliente ok / plantilla.
- [x] PATCH conversación `archived`.
- [x] Vista `archived` + regla de exclusión + contadores + DTO.
- [x] Rutas: ajustes inbox, archive-inactive, dev auto-archive, stage keepActive.
- [x] Ticker + instrumentation.
- [x] Evento `conversations.bulk`.
- [x] Unit: vistas/contadores, condición, ticker, role-matrix.

## T4. Archivo — cliente
- [x] Espejo list-state/helpers (hecho con T3: lo exigían typecheck y los unit).
- [x] Pastilla Archivadas, acción en fila, etiqueta en búsqueda.
- [x] Cabecera Archivar/Desarchivar + aviso en hilo.
- [x] Ajustes → Bandeja (interruptor, días, limpiar con conteo).
- [x] Etapas: "No archivar".

## T5. Verificación (19-oct, BD aislada :5433)
- [x] Gate técnico verde: typecheck, lint, 1744 unit, build.
- [x] E2E API `scripts/e2e-archivo.mjs` 66/66.
- [x] E2E UI `scripts/e2e-archivo-ui.mjs` 46/46 (estable en corridas
  sueltas; las esperas se miden desde la respuesta del PATCH porque en
  `next dev` las peticiones esperan en cola tras GETs en frío).
- [x] Regresión: selftest 438/438 (on) y 231/231 (off), asignación 86/86,
  roles 116/116, search-filters y responsive verdes, paginación 101/102
  (la falla "la conversación del enlace queda seleccionada" también falla
  en origin/main 4a6d5c6: previa).
- [x] Fix encontrado en E2E: `/api/pipeline/board` no devolvía `keepActive`
  (la casilla arrancaba sin control).
- [x] `e2e-search-filters`: filas por `li[data-conversation-id]` (la fila
  lleva ahora el botón de archivar).
- [x] Guiones `tests/e2e/us-archivo.md`, `tests/e2e/us-nombre-contacto.md`.
