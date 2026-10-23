# 029 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Respuestas rápidas del equipo
- [x] Migración 0028 (`sellers_create_quick_replies`, re-ejecutable) + schema
  + defaults de `inbox-settings`; `PUT /api/settings/inbox` parcial (no
  pisa campos que no vienen; también `overdueMinutes`).
- [x] Política pura `src/lib/quick-reply-policy.ts` + unit.
- [x] Store + rutas (`forbidden` 403) + `permissions.ts` + `{ quickReplies, canCreate }`.
- [x] Ajustes: página fuera de `(owner)` (misma URL), autor por fila,
  interruptor del Propietario.
- [x] Compositor: `QuickReplyDialog`, «+ Nueva» en `/`, «Guardar como respuesta rápida».

## T2. Cliente en la cita
- [x] `client-card.ts` + `GET /api/bookings/[id]/client` (`any*`) + unit (14).
- [x] `booking-client-card.tsx` en el panel y en la Lista («Ver cliente»).

## T3. Botones del detalle de cita
- [x] Grupos Resultado/Cambios, `outline`, «Cancelar cita» rojo con
  confirmación de dos pasos. «Realizada» usa `default` = acento white-label.

## T4. Verificación
- [x] Gate: typecheck, lint, 2325 unit, build.
- [x] E2E en BD aislada: respuestas-rapidas 97/97, cita-cliente 61/61; regresión
  roles 116, catalogo 125, agenda-calendario 125, agenda-presencial 197 + UI 64,
  archivo 66 + UI 46, selftest 641 on / 411 off. Fixes: overlays de Citas con
  `!mt-0` (franja de 24 px heredada de `space-y-6`, venía de 028), pie del
  compositor, guion 025 sección e (hoy viernes).
- [x] Revisión Fable de la implementación: sin bloqueantes; 3 no bloqueantes corregidos (3014095).

## T5. Despliegue (requiere OK del dueño)
- [x] FF a main 9de653e, push y deploy swwo5sfewhqsnn0pxaqiuo9g (23-oct, ~4m24s, running:healthy, migración 0028 aplicada, smoke 401 en rutas nuevas). Reversa = redeploy de 10005ae.
