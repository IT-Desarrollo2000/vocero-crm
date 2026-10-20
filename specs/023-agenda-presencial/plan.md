# 023 — Agenda presencial · plan

Spec: [spec.md](spec.md). Rama `023-agenda-presencial` (worktree
`vocero-crm-023`), desde main 9fbc74c. Migración **0025**. Todo detrás de
`AGENDA` (sin bandera nueva: el módulo entero sigue apagado en producción).

## 1. Modelo de datos (migración 0025, re-ejecutable)

**Tabla nueva `appointment_type`** (prefijo de id nuevo en `ids.ts`):
`id`, `organization_id` NOT NULL (cascade), `name`, `duration_minutes`
(10–480), `exclusive` bool, `position` int, `active` bool default true,
`seed_key` text NULL, `created_at`, `updated_at`.
- `unique (organization_id, seed_key)` → la siembra perezosa es idempotente
  aunque dos requests la disparen a la vez (`onConflictDoNothing`).
- Se desactiva, no se borra (las citas la referencian).

**`booking`** (+3 columnas):
- `appointment_type_id` → `appointment_type` (set null). NULL en bloqueos y en
  citas de la 015.
- `assigned_user_id` → `user` (set null). El vendedor.
- `exclusive` bool NOT NULL default false: **copia** de `type.exclusive` al
  crear (mismo patrón que `duration_minutes`); la necesita el índice parcial.

**`offered_slot`** (+1): `appointment_type_id` (set null). La oferta recuerda
el tipo; `book_slot` reserva ese tipo sin que el modelo lo repita.

**`calendar_settings`** (+1): `address` text NULL.

**Índices**:
- DROP `booking_org_active_slot_uq` (era lo que impedía a dos vendedores
  coincidir). Seguro: la agenda nunca se encendió en prod → tabla vacía;
  verificarlo antes de desplegar.
- `booking_type_exclusive_slot_uq` unique `(org, appointment_type_id,
  scheduled_at)` WHERE `exclusive AND status IN ('agendada','realizada') AND
  NOT is_test`.
- `booking_seller_slot_uq` unique `(org, assigned_user_id, scheduled_at)` WHERE
  `assigned_user_id IS NOT NULL AND kind='session' AND status IN (…) AND NOT
  is_test`.
- `booking_org_assignee_idx (org, assigned_user_id)` para la visibilidad.

Los índices únicos solo ven el mismo instante de inicio: son la red de
seguridad. El cierre real de la carrera es el candado del §3.

## 2. Motor de choques (puro, en `src/server/agenda/conflicts.ts`)

```
BusyItem = { id, kind, startUtc, endUtc, typeId, exclusive, assignedUserId,
             typeName, sellerName }
classify(candidate, busy[], ctx) → { hard: BusyItem[], soft: BusyItem[] }
ctx = { mode: "strict" }                       // agente IA y bot
    | { mode: "staff", typeId, typeExclusive, sellerId | null }
```
- `strict`: todo traslape es **hard** (decisión 4: la IA no pisa nada).
- `staff`: traslape con
  - un bloqueo → hard;
  - el mismo tipo, si el tipo es exclusivo (`ctx.typeExclusive ||
    item.exclusive`) → hard;
  - una cita del mismo vendedor (`sellerId` no nulo) → hard;
  - cualquier otra → **soft** (advertencia).

`availability.ts`:
- `buildCandidateSlots(settings, from, to, durationMinutes)`: la rejilla
  arranca cada `slotMinutes + buffer` y cada hueco dura lo que dura el **tipo**
  (`expandWorkingDayToUtc` gana un `stepMinutes` opcional; sin él, igual que
  hoy).
- `getBusyIntervals(org, range, { excludeBookingId }, db = getDb())` devuelve
  `BusyItem[]` (join a `appointment_type` y `user` para los nombres). Acepta
  `tx` para correr dentro del candado.
- `computeAvailability(org, { type, ctx, … })` → `AvailableSlot & { conflicts:
  BusyItem[] }`: se descartan los hard; los soft viajan como `conflicts`
  (en `strict` siempre vacío).
- `findSlot` igual, con el mismo `ctx`.

## 3. Servicio (`service.ts`) — candado por organización

Toda escritura que ocupa agenda (crear sesión, bloqueo, reprogramar, reactivar
estado, reasignar) corre en `db.transaction` que empieza con
`select pg_advisory_xact_lock(hashtext('agenda:' || org))`. Dentro: re-calcular
choques con `tx` → decidir → escribir. Así se cierran también los traslapes
parciales y la carrera de dos reservas de IA (CA-4). Volumen bajo: serializar
las escrituras de agenda de un negocio no cuesta nada. El 23505 sigue
traduciéndose a `slot_taken` (defensa en profundidad).

`createSessionBooking` (+ `typeId?`, `assignedUserId?`, `actorUserId?`,
`confirmOverlap?`, `mode`):
- Tipo: el de la oferta (`requireOffer`), o `typeId`, o el **tipo por defecto**
  (primer activo por `position`). Tipo inactivo o ajeno → `invalid`.
- Vendedor: explícito (solo lo pasa el Propietario) → si no,
  `conversation.assigned_user_id` → si no, `actorUserId` (humano). La IA no
  tiene actor: queda el asignado o NULL.
- `mode` = `strict` si `source = "ai"`, si no `staff`.
- hard → `slot_taken` con alternativas (las de la oferta, como hoy).
- soft y `!confirmOverlap` → nuevo código **`overlap_warning`** con
  `conflicts`. No se crea nada.
- Copia `duration_minutes` y `exclusive` del tipo.
- `deliverMeeting` sin cambios (con `enlace-fijo` sin sala es no-op).

`rescheduleBooking` (+ `confirmOverlap`, `mode`): mismas reglas con el tipo y
vendedor de la cita. `rescheduleForConversation` (bot) usa `strict`.
`createBlock`: los bloqueos siguen siendo de todo el negocio; un bloqueo
encima de citas existentes se permite (es una decisión del operador) pero la
respuesta lista las citas afectadas.
`assignBooking({ bookingId, userId | null })`: solo Propietario; valida que el
nuevo vendedor no tenga traslape (hard).
`markBookingStatus`: si la cita vuelve a ocupar agenda (desde `no_show`),
valida hard en `staff`.

`BookingErrorCode` gana `overlap_warning`; `http.ts` lo traduce a **409**
`{"error":{"code":"overlap_warning",…},"conflicts":[…]}` (mismo sobre anidado
que `slot_taken`).

## 4. Tipos de cita (`src/server/agenda/types-store.ts`)
`listTypes(org, { includeInactive })` (siembra perezosa si no hay ninguno),
`getDefaultType`, `resolveTypeByName(org, name)` (normaliza minúsculas y
acentos; exacto, luego prefijo), `createType`, `updateType`. Límites en
`src/lib/agenda-types.ts` (compartido con la UI).

## 5. Visibilidad
`listBookings(org, { viewer, sellerId?, typeId? })`:
- Vendedor: `assigned_user_id = yo OR assigned_user_id IS NULL` (incluye
  bloqueos).
- Propietario: todo.
`getOwnBooking` recibe el `viewer` en las rutas de usuario → 404 si no la ve.
El DTO gana `type {id,name} | null`, `assignedUser {id,name} | null`.
Las advertencias (§2) usan todas las citas: el detalle de una cita ajena se
limita a tipo, vendedor y hora.

## 6. API
| Ruta | Rol | Cambio |
|---|---|---|
| `GET /api/calendar/types` | any | lista (activos; `?all=1` solo owner) |
| `POST /api/calendar/types` | owner | alta |
| `PATCH /api/calendar/types/[id]` | owner | edición / desactivar / orden |
| `GET /api/calendar/availability` | any | `typeId`, `sellerId` (owner), `excludeBookingId`; slots con `conflicts` |
| `GET /api/bookings` | any | visibilidad + `sellerId`/`typeId`; DTO ampliado |
| `POST /api/bookings` | any | `typeId?`, `assignedUserId?` (owner), `confirmOverlap?`; 409 `overlap_warning` |
| `PATCH /api/bookings/[id]` | any | `reschedule` + `confirmOverlap?`; acción `assign` (owner) |
| `GET/PUT /api/calendar/settings` | owner | `address` |
| `GET /api/bot/availability` | bot | `type?` (id o nombre) |
| `POST/PATCH /api/bot/bookings` | bot | sin cambio de contrato (tipo de la oferta) |
Toda ruta nueva se clasifica en `src/lib/permissions.ts` y responde 404 con la
bandera apagada.

## 7. Agente (`agent.ts`, `actions.ts`, `prompts.ts`, `pipeline.ts`)
- `offer_slots` gana `type?: string`. El prompt lista los tipos activos
  (`"type":"<Prueba de manejo | Servicio | …>"`) y pide preguntar el tipo si el
  cliente no lo dijo.
- `offerSlots({ typeName })`: sin tipo resoluble → respuesta del motor "¿Qué
  tipo de cita te interesa? …" con los nombres reales (`ok:false`). Con un solo
  tipo activo, se usa ese. Disponibilidad `strict` con la duración del tipo;
  `replaceOffers` guarda el `typeId`.
- `bookSlot`: el tipo sale de la oferta. Confirmación "¡Listo! Te agendé tu
  {tipo en minúsculas} para {label}." + "Te esperamos en {dirección}." si hay
  dirección + enlace solo si la cita tiene enlace (camino remoto oculto).
- Prompt: "el asistente de WhatsApp" → "el asistente de mensajería".
- Sin filtro por canal: ya corre en Messenger/Instagram.

## 8. Recordatorios
Sin cambio de canal (decisión 7: IG/Messenger siguen `skipped`). El catálogo
de variables (`src/lib/reminders.ts`) gana `tipo de cita` y `dirección`.

## 9. UI
- **Ajustes → Agenda** (`agenda-client.tsx`): tarjeta **Tipos de cita**
  (tabla editable), campo **Dirección**, rótulo "Cada cuánto empieza un
  horario"; se ocultan la tarjeta de conector y `connector-credentials`
  (no se borran).
- **Citas** (`bookings-client.tsx`): botón **Nueva cita** → diálogo
  `booking-dialog.tsx` (compartido); filtros vendedor/tipo; tipo y vendedor
  en cada fila; "Reasignar" (owner); reprogramar con la misma rejilla y la
  advertencia; los textos de enlace solo aparecen si la cita tiene enlace.
- **Bandeja**: botón **Agendar** en la cabecera/panel de la conversación →
  el mismo diálogo con contacto + conversación prellenados (solo con
  `AGENDA` encendida).
- Diálogo: tipo → día → rejilla (los soft con etiqueta "Ocupado" y detalle) →
  vendedor (owner) → notas → Guardar. Un 409 `overlap_warning` abre la
  confirmación "A esa hora ya hay N cita(s) (…). ¿Agendar de todos modos?";
  un `slot_taken` muestra el aviso y recarga la rejilla.

## 10. Pruebas
- Unit: `conflicts` (strict/staff, cada regla), `buildCandidateSlots` con
  duración del tipo y paso, `resolveTypeByName`, siembra idempotente,
  `booking-race` (ahora: mismo tipo exclusivo / mismo vendedor), visibilidad,
  agente (sin tipo → pregunta; confirmación con dirección), permisos.
- E2E nuevo `scripts/e2e-agenda-presencial.mjs` (API + Playwright) para
  CA-1…CA-8, con BD propia (`vocero_023` en `vocero-e2e-pg`) y puerto 3103.
- Ajustar el bloque de agenda de `scripts/e2e-selftest.mjs` y correrlo con
  `AGENDA` encendida y apagada.

## 11. Ajustes tras la revisión del asesor (20-oct) — MANDAN sobre lo anterior

- **A1 (candado acotado)**: dentro de la transacción con
  `pg_advisory_xact_lock(hashtext('agenda:'||org))` van SOLO lecturas con `tx`
  (busy, oferta, conversación, tipo) + el INSERT/UPDATE, con
  `set local lock_timeout = '5s'`. Alternativas frescas (`refreshOffer` /
  `replaceOffers`), `clearOffers`, conector, etapa del lead y SSE van DESPUÉS
  del commit. El pool es de 10 conexiones (`src/lib/db/index.ts`). Patrón ya
  usado en `src/server/catalog/store.ts:288`.
- **A2 (tipo por defecto)**: no hay "primer tipo" implícito para humanos: en
  `POST /api/bookings` (session) `typeId` es **obligatorio** (422). Para el bot
  sin `type` y para ofertas legacy sin tipo: si hay un solo tipo activo, ese;
  si no, el **primer tipo activo NO exclusivo** por `position`. Nunca se cae
  en un tipo exclusivo por omisión.
- **A3 (visibilidad)**: `booking.created_by_user_id` (→ user, set null). El
  Vendedor ve: `assigned_user_id = yo OR created_by_user_id = yo OR
  assigned_user_id IS NULL`. Así quien agenda en una conversación ajena (o
  tras una reasignación) no pierde la cita.
- **A4 (pruebas que cambian)**: `tests/unit/booking-race.test.ts` gana mock de
  `transaction(fn) => fn(tx)` y `execute`; el selftest
  (`scripts/e2e-selftest.mjs` ~1254-1273) agrega `/api/calendar/types` a la
  lista de 404 con bandera apagada y el check "el hueco reservado desaparece"
  (~1410) consulta con el mismo tipo exclusivo o comprueba `conflicts`.
- **A5 (miembros)**: `assignedUserId` debe ser miembro de la organización
  (tabla `member`); un Vendedor que lo envía recibe 403.
- **A6 (buffer)**: el margen entre citas se aplica al choque: un ocupado
  cuenta como `[start, end + buffer)`.
- **A7 (reprogramar en UI)**: la rejilla se pide por cita (`typeId`,
  `sellerId`, `excludeBookingId`) y maneja `overlap_warning`.
- **A8 (recordatorios)**: `ReminderBooking` en `reminder-store.ts` selecciona
  tipo y dirección; `REMINDER_FIELDS` + `renderReminderVariables` ganan
  `appointment_type` y `address` con respaldo no vacío ("nuestra sucursal");
  actualizar los tests de recordatorios.
- **A9 (bot PATCH)**: acepta `bookingId?` opcional; sin él, conserva el
  comportamiento actual.
- **A10 (nombre de tipo)**: exacto normalizado; prefijo solo si es único; si no
  → preguntar.
- **A11 (tipo desactivado entre oferta y reserva)**: se trata como
  `slot_taken` con re-oferta (o la pregunta de tipo), no como `invalid`.
- **A12 (contexto del agente)**: `src/server/ai/contact-context.ts` muestra el
  tipo en "próxima cita".
- **A13 (migración)**: SQL editado a mano re-ejecutable (`IF NOT EXISTS`,
  `DROP INDEX IF EXISTS`), como `drizzle/0024_leads_externos.sql`.
- Recorte: el orden de tipos se edita con `position` (sin arrastrar).

## Riesgos
- **Choque de merge** con otras ramas en `permissions.ts`,
  `e2e-selftest.mjs`, `schema.ts`: rebasar sobre origin/main antes de cerrar.
- **Advisory lock en pooler**: `pg_advisory_xact_lock` vive en la
  transacción; funciona en modo transacción del pooler.
- `slotMinutes` cambia de significado (rejilla, no duración): las citas de la
  015 conservan su `duration_minutes` copiado.
