# 028 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.
Fases según A9: **Fase A** = rango + `overlaps` + vistas + panel + colores;
**Fase B** = `move` + arrastre. "Verificado" = gate unitario en
verde (Fases A y B); el E2E de comportamiento sigue pendiente (T3).

## T0. Port de upstream (A0, archivos sueltos, sin merge)
- [x] `src/lib/time/calendar.ts` tal cual (4a0d0be + ayudantes de f58e69b) +
  `tests/unit/calendario-citas.test.ts` (25 pruebas).
- [x] `partsInTz` con un formateador por zona (3130b4b) en `slots.ts`.
- [x] De `calendario-citas-arreglos.test.ts`: `blockStartUtc`, `coalesce`,
  `calendarVisible` (sin "fallo 2" ni la revisión de `booking-drawer.tsx`).
- [x] `.booking-hatch` / `--cal-off` adaptados a nuestros tokens (A7).

## T1. Servidor
- [x] Fase A — `GET /api/bookings?from=&to=`: `listBookingsInRange` sobre
  nuestro listado (visibilidad, tipo, vendedor, recordatorios), medianoche
  del negocio, lookback 24 h + post-filtro, asc, `truncated`, ≤ 92 días,
  422 `invalid_range`; `hours` (5 campos) y `overlaps` (A4, soft/hard sobre
  toda la org, sin buffer, sin pruebas; reemplaza al `overlapIds` del plan
  original). Sin rango: idéntico a antes.
- [x] Fase B — `moveBooking` atómico en `service.ts` (un candado, un UPDATE;
  helpers `findMovableSlot` / `assertSellerFree` / `checkBlockMove` con `tx`;
  `stale` 409; bloqueos A5) + `PATCH /api/bookings/[id]` `action:"move"`
  (`userId` solo Propietario). Unit: `agenda-move.test.ts` + rutas.
- [x] Fase A — Unit: `calendario-rango-api.test.ts` (rango, bordes, lookback,
  visibilidad, filtros, `truncated`, 422, `hours`, `overlaps`, sin rango
  idéntico) + traslapes en `calendario-modelo.test.ts`.

## T2. Cliente
- [x] Fase A — `calendar/calendar-model.ts` puro + unit: vista por defecto,
  rango visible A3, filas, posición, columnas por vendedor, color por hash,
  rejilla real (`gridStarts`/`validStarts` con buffer y aviso mínimo),
  `snapMinute` y `previewState` (A1, listos para la Fase B).
- [x] Fase A — Semana (`week-view.tsx`), Día por vendedor
  (`day-sellers-view.tsx`), rejilla compartida (`time-grid.tsx`), bloque
  (`booking-block.tsx`), leyenda (`calendar-legend.tsx`), barra
  (`calendar-toolbar.tsx`), panel (`booking-detail-panel.tsx`) con las
  acciones compartidas de la fila (`booking-actions.tsx`).
- [x] Fase A — Selector de vista y defaults (localStorage con try/catch);
  colores claro/oscuro (`--cal-off`, `--cal-type-1..6`); canceladas y pruebas
  ocultas con interruptores; SSE con `coalesce`.
- [x] Fase A — A8: bloqueo con `blockStartUtc` (hora del negocio);
  `BookingDialog` con `initialDayIso/initialStartUtc` tras cargar la rejilla
  y aviso si el hueco no está en ella.
- [x] Fase B — Arrastre con dnd-kit (`calendar-dnd.tsx`, `drag-model.ts`,
  `move-overlap-dialog.tsx`): un droppable por columna, sensores puntero
  (mouse) / táctil (pulsación larga) / teclado, `DragOverlay`, vista previa
  `previewState`, optimista con reversión, confirmación de choque, SSE en
  pausa. Unit: `calendario-arrastre.test.ts`.
- [x] Fases A y B — Gate `pnpm typecheck && pnpm lint && pnpm test` en verde.

## T3. Verificación
- [x] E2E Playwright CA-1…CA-8 (`scripts/e2e-agenda-calendario.mjs`, navegador en Asia/Tokyo, mouse real, teclado, auto-scroll, margen 15 min): 125 on / 8 off; regresión e2e-agenda-presencial 197 + UI 64, selftest 641 on / 411 off; build verde. Bug real corregido: el DragOverlay heredaba margin-top y el soltado caía una fila abajo.
  (`e2e-agenda-presencial-ui.mjs` ya elige la vista Lista tras abrir Citas;
  falta correrlo.)
- [x] Revisión Fable (plan + implementación): sin bloqueantes; R1 carga fallida sin salida y R2 Escape cerraba panel+diálogo corregidos; franja ámbar para traslape permitido (pedido del dueño).

## T4. Despliegue (requiere OK del dueño)
- [ ] Merge + push + deploy.
