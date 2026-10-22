# 028 — plan

Spec: [spec.md](spec.md). Rama `028-agenda-calendario` (worktree
`vocero-crm-023`) desde origin/main 442d95d. Sin migración.

## Servidor
- `GET /api/bookings` gana `from`/`to` (fechas `YYYY-MM-DD` en la zona del
  negocio; tope 62 días). Con rango: todas las citas del rango (sin el límite
  de 200), con la misma visibilidad y filtros. Sin rango: comportamiento
  actual (Lista).
- La respuesta suma, solo con rango:
  - `hours`: horario semanal + `slotMinutes` + `timezone` (lectura mínima; el
    Vendedor hoy no puede leer `/api/calendar/settings`);
  - `overlapIds`: ids de citas activas que se traslapan con otra cita activa
    (cálculo en servidor con la misma función de traslape de `conflicts.ts`).
- `PATCH /api/bookings/[id]` acción nueva **`move`** `{ startUtc?, userId?,
  confirmOverlap? }`: mueve hora y/o vendedor de forma ATÓMICA dentro del
  candado de la org (`service.ts`), con las reglas de reprogramar +
  reasignar (modo staff). `userId` solo Propietario (403 si no). Mismos 409
  `slot_taken` / `overlap_warning`. Bloqueos: solo `startUtc` (strict).
  Se mantiene `reschedule` y `assign` para compatibilidad.

## Cliente (`src/components/bookings/`)
- `calendar/` (nuevo):
  - `calendar-model.ts` (PURO): semana/día en la zona del negocio, filas por
    `slotMinutes`, posición/alto de cada cita, columnas lado a lado para
    traslapes (algoritmo de carriles), celdas fuera de horario, snap del
    arrastre a la rejilla, estado visual de cada cita.
  - `week-view.tsx`, `day-sellers-view.tsx`, `booking-block.tsx`,
    `calendar-legend.tsx`, `booking-detail-panel.tsx`.
  - Arrastre con `@dnd-kit/core` (ya usado en `pipeline-client.tsx`):
    sensores puntero + teclado; celdas como zonas de soltado; al soltar →
    PATCH `move`; optimista con reversión; maneja `overlap_warning`
    (confirmación) y `slot_taken` (aviso + reversión).
- `bookings-client.tsx`: selector de vista Semana | Día | Lista (recordado
  en `localStorage` con try/catch), por defecto Semana en ≥ md y Día en
  móvil; los filtros existentes aplican a las tres vistas; SSE
  `booking.updated` refresca el rango visible.
- Colores: tokens existentes (`brand-*`, `warning-*`, `success-*`,
  `danger-*`, neutros) + paleta fija de 6 colores para el punto del tipo
  (definida en `globals.css` con variantes claro/oscuro). Estados con ícono
  además del color (traslapada ⚠, realizada ✓, no asistió ✗, bloqueo 🔒 vía
  lucide).
- Accesibilidad: bloques como botones con `aria-label` completo; teclado en
  dnd-kit; foco y Escape en el panel.

## Ajustes tras la revisión del asesor (22-oct) — MANDAN sobre lo anterior

- **A0 (portar de upstream, sin merge)**: `upstream/main` ya trae el
  calendario (`4a0d0be`, `f58e69b`, `154fb9a`, `3130b4b`). Se portan como
  ARCHIVOS: `src/lib/time/calendar.ts` + `tests/unit/calendario-citas.test.ts`
  (puros: `wallClock`, `bookingSegments`, `layoutOverlaps`, `workingBands`/
  `offHoursBands`, `parseRangeQuery`, `coalesce`, `calendarVisible`,
  `blockStartUtc`) y el arreglo de rendimiento de `partsInTz` en `slots.ts`.
  `listBookingsInRange` se adapta sobre NUESTRO `listBookings` (visibilidad,
  tipo, vendedor, recordatorios): corte a medianoche del negocio, lookback
  24 h + post-filtro por fin, orden asc, `truncated`, ≤ 92 días. Sin rango,
  `GET /api/bookings` responde EXACTO lo de hoy. Se conservan los nombres de
  archivo de upstream donde aplique (`time-grid.tsx`, `booking-look.ts`,
  `calendar-toolbar.tsx`). La UI de upstream NO se porta tal cual.
- **A1 (rejilla real)**: `hours` = `weeklyHours, slotMinutes, bufferMinutes,
  minNoticeHours, timezone`. El modelo calcula los inicios válidos con
  `expandWorkingDayToUtc` (paso `slot+buffer` anclado al inicio de cada
  intervalo, la cita completa debe caber, ≥ ahora + aviso mínimo). La vista
  previa del arrastre distingue: libre · ocupado (choque) · fuera de horario ·
  no cabe antes del cierre · demasiado pronto · día cerrado.
- **A2 (`move` atómico)**: helpers que reciben `tx` (extraídos de
  reprogramar/reasignar) bajo UN `withAgendaLock` y UN `UPDATE`
  (`scheduledAt` + `assignedUserId`). `ctx.sellerId` = vendedor DESTINO.
  Solo cambia vendedor → `conflictsAt` sin rejilla. Solo `status='agendada'`
  y no `isTest`. `isOrgMember(tx)` del destino. 23505 → `slot_taken`.
  `updateMeeting` del conector solo si cambió la hora y después del commit.
  Opcional `expectedStartUtc` → 409 `stale` si otro ya la movió.
- **A3 (rango visible)**: de min(apertura, inicio de citas cargadas) a
  max(cierre, fin de citas cargadas) de la semana/día; scroll inicial a la
  apertura.
- **A4 (traslape en dos niveles, calculado en servidor sobre toda la org
  antes de la visibilidad, solo sesiones activas no-test, sin buffer, con
  lookback)**: `overlaps: { [bookingId]: "soft" | "hard" }`. `hard` = choque
  que sería rechazo según `isHard` en el ctx de esa cita (bloqueo encima,
  mismo vendedor, mismo tipo exclusivo); `soft` = traslape permitido con
  otro vendedor. Es un ATRIBUTO (borde + ícono) sobre el color de estado:
  soft = ícono ⧉ discreto + carriles lado a lado; hard = borde de alerta +
  ⚠ "Conflicto".
- **A5 (bloqueos)**: moverlos sigue la semántica de crearlos: pueden caer
  sobre citas (snap a `slotMinutes` desde las 00:00 local, sin exigir horario
  hábil) y, si cubren citas, se pide confirmación "Este bloqueo cubrirá N
  citas" (reusa el flujo `overlap_warning` + `confirmOverlap`).
- **A6 (dnd-kit)**: UN droppable por columna (día o vendedor); el minuto se
  calcula por coordenada Y con snap en el modelo puro. `PointerSensor
  {distance:6}` + `onClick` (como pipeline); en táctil `TouchSensor
  {delay:250,tolerance:8}`; `KeyboardSensor` con paso de rejilla.
  `DragOverlay`. El SSE se pausa durante el arrastre y se aplica al soltar
  (`coalesce` para ráfagas).
- **A7 (colores)**: tokens nuevos `--cal-off` y `--cal-type-1..6` (claro y
  oscuro) en `globals.css`; color de tipo por HASH del `typeId` (estable),
  evitando ámbar/verde/rojo de estados. Agendada `bg-brand text-brand-fg`;
  realizada verde apagado; no asistió rojo apagado; bloqueo rayado
  (`.booking-hatch`); canceladas y pruebas ocultas por defecto con
  interruptores "Mostrar canceladas" / "Mostrar pruebas"; nada de color solo
  (íconos/texto).
- **A8 (detalle)**: arreglar el bloqueo creado con la hora del NAVEGADOR
  (`bookings-client.tsx` ~219 → `blockStartUtc`). `BookingDialog` acepta
  `initialDayIso/initialStartUtc` aplicados tras cargar la rejilla del tipo;
  si el hueco no está en la rejilla, se dice. Acciones de la fila extraídas a
  un componente compartido con el panel de detalle.
- **A9 (fases)**: Fase A = rango + `overlaps` + vistas + panel + colores
  (verificable sola); Fase B = `move` + arrastre.
- **A10 (E2E)**: navegador con `timezoneId: "Asia/Tokyo"`; un caso con
  `bufferMinutes > 0`.

## Pruebas
- Unit: `calendar-model` (posiciones, carriles, fuera de horario, snap, zona
  horaria y medianoche, estado visual), `overlapIds`, `move` (atómico,
  reglas, permisos), rango de `GET /api/bookings`.
- E2E Playwright (`scripts/e2e-agenda-calendario.mjs`, BD `vocero_023`,
  puerto 3103): CA-1…CA-8 incluido arrastrar con el mouse real
  (`page.mouse`), confirmación de choque, rechazo y reversión, reasignar por
  columna, visibilidad del Vendedor, móvil 390 px, tema oscuro, capturas.
- Regresión: `e2e-agenda-presencial` (+ `-ui`), selftest on/off.
