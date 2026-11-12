# 035 — Tareas de la fase A

- [x] T1 Esquema `follow_up` + prefijo `fu` + migración 0030 re-ejecutable
- [x] T2 `src/lib/follow-ups.ts` puro (Zod, repetir, posponer, grupos, etiquetas) + unit
- [x] T3 `src/server/follow-ups/` (store: listar, crear, hecho, posponer, contador; pendientes: sin contacto, sin respuesta)
- [x] T4 Rutas `/api/follow-ups…` + `src/lib/permissions.ts`
- [x] T5 Diálogo «Recordarme» (`src/components/follow-ups/remind-dialog.tsx`)
- [x] T6 Pendientes (`/pipeline?vista=pendientes`) con selector «Tablero | Pendientes»
- [x] T7 «Recordarme» en el chat, el cajón del trato (+ historial) y Contactos (+ `?q=`)
- [x] T8 Número rojo de vencidos junto a «Seguimiento»
- [x] T9 Gate: typecheck, lint, build, test
- [x] T10 E2E `scripts/e2e-pendientes.mjs` (+ `tests/e2e/us-pendientes.md`) + `pendientesChecks()` en el self-test
- [x] T11 Capturas en la BD aislada

# 035 — Tareas de la fase B (Avisos) · plan: [plan-b.md](plan-b.md)

- [x] B1 Esquema `notification` + prefijo `ntf` + migración 0031 re-ejecutable (UNIQUE de `dedupe_key`)
- [x] B2 `src/lib/notifications.ts` puro (claves, regla del resumen, textos) + unit
- [x] B3 `src/server/notifications/` (store, `tick.ts`, reloj `ticker.ts` con `NOTIFICATIONS_TICK_MS`) + `POST /api/dev/notifications/tick`
- [x] B4 Avisos de asignación (chat en la ruta de asignar, cita en `createSessionBooking` / `PATCH /api/bookings/[id]`), sin tumbar la operación
- [x] B5 SSE `notification.changed` + `follow_ups.changed` (solo al destinatario) + unit de visibilidad
- [x] B6 `GET /api/notifications`, `POST /api/notifications/read`, `/api/follow-ups/count` con `today` + `src/lib/permissions.ts`
- [x] B7 Campana «Avisos» (lateral y encabezado móvil), aviso emergente, «Activar avisos del navegador»
- [x] B8 Línea «… recordatorios para hoy» en «Esto es lo que te toca ahora»
- [x] B9 Gate: typecheck, lint, build, test
- [x] B10 E2E `scripts/e2e-avisos.mjs` (+ `tests/e2e/us-avisos.md`)
- [x] B11 Ayuda: tema `recordatorios` (+ `contenido.md` § 5d), capturas `recordarme.png`, `pendientes.png`, `avisos.png` (`scripts/ayuda-capturas.mjs`), test de `help-topics` y `#recordatorios` en `scripts/e2e-ayuda.mjs`
- [x] B12 `CLAUDE.md`: fila 035 en el mapa del código
