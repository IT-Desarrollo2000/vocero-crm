# 026 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Migración 0027
- [x] `conversation.awaiting_since`, `inbox_settings.overdue_minutes`; backfill idempotente.

## T2. Escrituras
- [x] Ingest (WA/IG/Messenger) + leads externos fijan la espera.
- [x] `persistOutbound` (no failed), eco del teléfono, `bot/reset` la limpian; `sendTemplate` con `attends` (recordatorios `false`).
- [x] `markHandoff` la fija (salvo `manual_reply`).
- [x] PATCH `attended` (+ `aiEnabled`).

## T3. Lectura + UI
- [x] DTO `awaitingSince`; filtro `human` = esperando; espejo cliente + conteo de respaldo.
- [x] `src/lib/awaiting.ts`; etiquetas de la fila; panel con "Marcar como atendida".
- [x] Umbral en Ajustes → Bandeja y hasta la Bandeja.

## T4. Verificación
- [x] Unit + gate (`pnpm typecheck && pnpm lint && pnpm build && pnpm test`).
- [x] E2E `porAtenderChecks` CA-1…CA-9 + revisión visual.
- [x] Revisión Fable (plan + implementación): 3 bloqueantes del plan corregidos; implementación sin bloqueantes (backfill acotado a filas que esperan).

## T5. Despliegue
- [x] Push 0e2c690 a main + deploy 9apkixbqahvhgzti0w0e86eq (22-oct, OK del dueño, ~5 min, running:healthy, migración 0027 aplicada, smoke OK). Reversa = redeploy de dce9dc5.
