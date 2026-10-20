# 023 — Agenda presencial · tareas

Plan: [plan.md](plan.md). Rama `023-agenda-presencial` (worktree
`vocero-crm-023`). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Migración 0025 + esquema
- [x] schema.ts: tabla `appointment_type`; `booking.appointment_type_id`,
  `assigned_user_id`, `exclusive`; `offered_slot.appointment_type_id`;
  `calendar_settings.address`; índices (drop org-wide, add exclusivo/vendedor).
- [x] `pnpm db:generate --name agenda_presencial`; SQL re-ejecutable.
- [x] Prefijo de id nuevo en `ids.ts`.

## T2. Servidor — motor
- [x] `src/lib/agenda-types.ts` (límites, siembra) + `types-store.ts`.
- [x] `conflicts.ts` (puro) + `availability.ts` (duración por tipo, paso,
  `BusyItem`, `tx`).
- [x] `service.ts`: candado por org, tipo, vendedor, `overlap_warning`,
  `assignBooking`, reprogramar/estado con reglas; `http.ts` 409.
- [x] `queries.ts`: visibilidad + filtros + DTO.
- [x] `settings.ts`: `address`.

## T3. Servidor — superficies
- [x] Rutas `/api/calendar/types` (+ `[id]`), availability, bookings (GET/POST/
  PATCH), settings; permisos clasificados; 404 con bandera apagada.
- [x] Bot: availability `type?`; bookings con tipo de la oferta.
- [x] Agente: acción `offer_slots.type`, `agent.ts`, prompt, pipeline.
- [x] Recordatorios: variables `tipo de cita` y `dirección`.
- [x] Unit: conflicts, slots, types-store, booking-race, visibilidad, agente,
  permisos.
- [x] Gate: typecheck + lint + test.

## T4. UI
- [x] Ajustes → Agenda: tipos de cita, dirección, ocultar conectores, rótulo
  de rejilla.
- [x] `booking-dialog.tsx` compartido (tipo, día, rejilla con "Ocupado",
  vendedor, notas, confirmación de choque).
- [x] Citas: Nueva cita, filtros, tipo/vendedor por fila, reasignar,
  reprogramar con advertencia, textos de enlace condicionales.
- [x] Bandeja: botón Agendar.
- [x] Gate + build. typecheck + lint + test verdes (1999 tests); build pendiente (lo corre el orquestador).

## T5. Verificación
- [x] `scripts/e2e-agenda-presencial.mjs` (API, CA-1…CA-8 con el agente real
  en Messenger/Instagram) 152 OK on / 21 OK `--off` +
  `scripts/e2e-agenda-presencial-ui.mjs` (Playwright) 64 OK.
- [x] `e2e-selftest.mjs` agenda ajustado; selftest 491 on / 282 off;
  `e2e-recordatorios` 75.
- [x] Revisión final (asesor Fable): 2 bloqueantes corregidos (contacto de
  otra org; el camino manual pisaba la oferta de la IA) + memoria.
- [x] Gate: typecheck + lint + build + test (155 archivos / 2011 tests).

## Pendiente para desplegar (requiere OK del dueño)
- [ ] Rebase sobre origin/main, commit y push.
- [ ] Confirmar que `booking` en prod está vacía (la 0025 quita el índice
  único de la 015).
- [ ] Deploy; encender `AGENDA=on` en Coolify cuando el dueño lo decida.
