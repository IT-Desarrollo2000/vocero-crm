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
- [ ] `src/server/inbox/archive.ts` (condición, masiva, auto).
- [ ] Desarchivar en entrante / origen sin mensaje / eco / saliente ok / plantilla.
- [ ] PATCH conversación `archived`.
- [ ] Vista `archived` + regla de exclusión + contadores + DTO.
- [ ] Rutas: ajustes inbox, archive-inactive, dev auto-archive, stage keepActive.
- [ ] Ticker + instrumentation.
- [ ] Evento `conversations.bulk`.
- [ ] Unit: vistas/contadores, condición, ticker, role-matrix.

## T4. Archivo — cliente
- [ ] Espejo list-state/helpers.
- [ ] Pastilla Archivadas, acción en fila, etiqueta en búsqueda.
- [ ] Cabecera Archivar/Desarchivar + aviso en hilo.
- [ ] Ajustes → Bandeja (interruptor, días, limpiar con conteo).
- [ ] Etapas: "No archivar".

## T5. Verificación
- [ ] Gate técnico verde.
- [ ] E2E API (selftest) verde.
- [ ] E2E UI `scripts/e2e-archivo-ui.mjs` verde.
- [ ] Guiones `.md`.
