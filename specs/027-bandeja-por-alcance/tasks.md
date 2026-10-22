# 027 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Servidor
- [x] `assigned=others`; `counts.scopes` al final del SELECT.

## T2. Cliente
- [x] Estado `scope` (URL, legado, default por rol + localStorage, `q` global, espejo).
- [x] Selector con totales y punto; vistas sin "Mías"; Filtros sin "Sin asignar"; vacíos.
- [x] Aviso "ahora está en …· Ir"; "Devolver al buzón".
- [x] US-6: recordatorio del Buzón (vacío de Mis chats + panel derecho).

## T3. Verificación
- [x] Unit + gate (`pnpm typecheck && pnpm lint && pnpm build && pnpm test`).
- [x] E2E selftest + guion de alcance + guiones de UI afectados + revisión visual.
  (22-oct: selftest 641/641; e2e-bandeja-alcance 66/66 con CA-10 N = 0; el
  vacío del Vendedor con Buzón vacío caía en la demo — corregido en
  `conversation-list.tsx`.)
- [x] Revisión Fable (plan + implementación): 5 bloqueantes del plan resueltos; implementación sin bloqueantes (menores 1 y 3 aplicados).

## T4. Despliegue
- [ ] Merge + push + deploy (pedir OK al dueño).
