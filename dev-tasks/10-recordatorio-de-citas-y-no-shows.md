# 10 — Recordatorio de citas y no-shows

> Estado: propuesto · Prioridad: media · Esfuerzo: L · Migración: sí · Bandera: `AGENDA` (existente) + ajuste por organización `reminderEnabled` (apagado por defecto)

## 1. Especificación

### Problema / objetivo

Hoy una cita agendada (por la IA, el bot externo o el operador) no tiene
seguimiento automático: nadie le recuerda al cliente y el negocio solo se
entera del no-show cuando el cliente ya no llega. Tampoco hay forma de saber
cuántas ofertas de horario terminan en cita ni cuántas citas terminan en
asistencia.

Objetivo: (1) enviar por WhatsApp un **recordatorio con plantilla aprobada**
X horas antes de cada cita (configurable, p. ej. 24 h y/o 2 h), de forma
**idempotente y tolerante a reinicios**, sin cola ni cron externos; (2) dejar
el **resultado visible en la cita** (enviado / fallido / omitido + estado de
entrega de Meta); (3) dar al Propietario **métricas** de oferta→cita y
cita→asistencia.

La spec 015 dejó esto explícitamente fuera de v1 ("Sin recordatorios
automáticos en v1: el core no tiene infraestructura de cron",
`specs/015-motor-agenda-universal/spec.md:544`, `plan.md:79`, `tasks.md:188`).
Esta tarea es la enmienda post-v1 y debe actualizar esos artefactos.

### Alcance (incluye) / Fuera de alcance

**Incluye**
- Ajustes → Agenda (solo Propietario): activar recordatorios, elegir la
  plantilla **aprobada**, mapear sus variables `{{n}}` y fijar 1 o 2
  anticipaciones (horas).
- Ticker in-process (sin cola externa) que detecta recordatorios vencidos y los
  envía con `sendTemplate`, con **claim atómico** en BD (seguro con reinicios y
  con N réplicas).
- Registro por cita y anticipación (`booking_reminder`, nuevo): enviado,
  fallido (con motivo), omitido (con motivo), y estado de entrega del mensaje
  (sent/delivered/read/failed vía webhook de estados ya existente).
- Reintento manual de un recordatorio fallido desde "Citas".
- Registro durable de ofertas (`agenda_offer_log`, nuevo) y endpoint de
  métricas solo Propietario.
- Respuesta del cliente al recordatorio (texto libre): llega a la Bandeja, abre
  la ventana de 24 h y la atiende el agente con sus reglas actuales
  (cancelación → handoff, `src/server/ai/prompts.ts:47`).

**Fuera de alcance (fase 1)**
- **Botones de plantilla "Confirmar / Cancelar"** con efecto automático sobre la
  cita. Hoy es imposible sin dos extensiones: `createTemplate` solo manda el
  componente `BODY` (`src/server/whatsapp/templates.ts:106-114`) y el ingest
  ignora mensajes `button`/`interactive` (`SUPPORTED_TYPES` en
  `src/server/inbox/ingest.ts:27-36`, `continue` en `:237`). Se propone como
  **fase 2** (ver Riesgos y decisiones abiertas, D-10-04).
- Recordatorios por Instagram/Messenger (no existen plantillas fuera de
  WhatsApp, `templates.ts:338-346`).
- Recordatorios por email/SMS (prohibido por soberanía, constitución II).
- Marcado automático de `no_show` por reloj (lo sigue marcando una persona).
- Recordatorios al operador/vendedor (notificación interna).

### Historias de usuario

- Como **Propietario** quiero elegir una plantilla aprobada y cuántas horas antes
  se manda el recordatorio, para reducir las inasistencias sin trabajo manual.
- Como **Propietario** quiero ver qué % de las ofertas de horario terminan en
  cita y qué % de las citas terminan en asistencia, para saber si el agente y
  los recordatorios funcionan.
- Como **Vendedor** quiero ver en cada cita si el recordatorio salió, si se
  entregó o por qué falló, para llamar al cliente cuando no le llegó.
- Como **Vendedor** quiero reintentar un recordatorio fallido con un clic, para
  no depender de que el Propietario entre a Ajustes.
- Como **Vendedor** quiero que la respuesta del cliente al recordatorio me
  llegue a la Bandeja, para confirmar o reprogramar con él.

### Requisitos funcionales

- **RF-10-01** Con `AGENDA` apagada no existe nada de esta tarea: rutas nuevas →
  404 (`agendaDisabledResponse`, `src/server/agenda/flag.ts:49-51`), sin sección
  en Ajustes, sin columna en Citas y **el ticker no arranca**.
- **RF-10-02** Ajustes de agenda guarda: `reminderEnabled` (default `false`),
  `reminderTemplateId` (FK a `template`), `reminderOffsetsMinutes` (1 o 2
  valores, cada uno entre 60 y 4320 min; default `[1440]`) y
  `reminderVariables` (mapeo posición `{{n}}` → campo del catálogo). Guardar con
  `reminderEnabled=true` exige plantilla con `status='approved'`, canal
  WhatsApp, y un mapeo para **cada** variable de la plantilla
  (`countVariables`, `templates.ts:299`); si no, 422 con mensaje.
- **RF-10-03** Catálogo cerrado de campos para variables: `contact_name`,
  `booking_datetime` (etiqueta en la zona del negocio con `labelInTz`,
  `src/lib/time/slots.ts:217`), `meeting_link` (si es null → texto de respaldo
  fijo "te lo compartimos por este medio"), `business_name` (nombre de la
  organización). Nunca se manda un parámetro vacío (Meta responde 132000 y
  `sendTemplate` lo rechaza, `templates.ts:300-312`).
- **RF-10-04** Un recordatorio es **elegible** si: `booking.kind='session'`,
  `status='agendada'`, `is_test=false`, la organización tiene
  `reminderEnabled=true`, y para la anticipación `o`: `due = scheduled_at − o`,
  `due ≥ booking.created_at` (la cita existía cuando tocaba), `due ≤ now`,
  `now − due ≤ gracia(o)` con `gracia(o) = min(o/4, 6 h)`, y
  `now ≤ scheduled_at − 15 min`.
- **RF-10-05** **Idempotencia**: a lo sumo un intento automático por
  `(booking_id, offset_minutes, scheduled_for)`, garantizado por UNIQUE en BD y
  claim por `INSERT … ON CONFLICT DO NOTHING RETURNING`. Dos ticks simultáneos
  (dos réplicas, o un tick lento solapado) jamás envían dos veces.
- **RF-10-06** **Reprogramar** cambia `scheduled_for` y por tanto genera
  recordatorios nuevos para la hora nueva; los de la hora anterior quedan como
  historial. **Cancelar** o marcar `realizada`/`no_show` excluye la cita de la
  query: no se envía nada después.
- **RF-10-07** **Sandbox**: una cita `is_test` (Laboratorio) nunca genera fila ni
  envío. Doble barrera: filtro `is_test=false` en la query del ticker + la
  aserción `sandbox_violation` de `sendTemplate` (`templates.ts:331-337`).
- **RF-10-08** Conversación destino: `booking.conversation_id` si existe; si es
  null (cita manual, `src/app/api/bookings/route.ts:20,61`) se usa la
  conversación real del contacto o se crea con `getOrCreateConversation`
  (`src/server/inbox/ingest.ts:167`), igual que
  `src/app/api/contacts/[id]/start-conversation/route.ts:76-77`.
- **RF-10-09** Resultado registrado en `booking_reminder.status`:
  `sending` → `sent` (con `message_id`) | `failed` (con `error`) | `skipped`
  (con `reason`: `template_not_approved`, `template_missing`,
  `channel_not_whatsapp`, `not_connected`, `reconnect_required`,
  `no_recipient`). El estado de entrega se lee del `message` enlazado
  (actualizado por `applyStatusUpdate`, `src/server/inbox/status.ts:25-67`).
- **RF-10-10** Una fila `sending` con más de 10 min (proceso muerto entre claim
  y envío) pasa a `failed` con `error='interrumpido'`. **No se reenvía sola**
  (al-menos-una-vez sería peor que a-lo-sumo-una-vez: un recordatorio duplicado
  molesta al cliente); queda para reintento manual.
- **RF-10-11** Reintento manual: `failed` → `sending` con claim condicionado
  (`UPDATE … WHERE status='failed' RETURNING`, patrón de
  `src/server/attribution/conversions.ts:311-325`); solo si la cita sigue
  `agendada` y no pasó su hora. Reusa la misma fila.
- **RF-10-12** La lista de citas (`GET /api/bookings`) incluye por cita el
  recordatorio vigente (el de `scheduled_for = scheduled_at`) por anticipación:
  estado, motivo/error, `sentAt` y estado de entrega del mensaje.
- **RF-10-13** Cada cambio de un recordatorio publica `booking.updated` por SSE
  (la vista Citas ya escucha, `src/components/bookings/bookings-client.tsx:54`).
- **RF-10-14** Registro de ofertas: cada ronda de `replaceOffers` agrega una fila
  en `agenda_offer_log` (append-only, con `is_test` de la conversación) DESPUÉS
  de confirmar la transacción de la oferta, en `try/catch`: un fallo del log **no** revierte ni bloquea la oferta.
- **RF-10-15** Métricas (solo Propietario) para un rango `[from,to)`:
  - Oferta→cita = conversaciones reales con ≥1 ronda ofrecida en el rango que
    tienen una cita `source='ai'` creada después de su primera oferta /
    conversaciones reales con ≥1 ronda ofrecida en el rango.
  - Cita→asistencia = `realizada` / (`realizada` + `no_show`) de citas
    `session`, no prueba, con `scheduled_at` en el rango. Se informa aparte
    "pendientes de marcar" (`agendada` con `scheduled_at < now`).
  - Desglose de asistencia **con** vs **sin** recordatorio enviado.
  - Datos de oferta solo existen desde la migración: la UI lo dice.
- **RF-10-16** Ningún fallo de esta tarea bloquea la agenda: crear, reprogramar,
  cancelar y marcar citas funcionan igual si el ticker, la plantilla o Meta
  fallan.

### Permisos por rol

| Superficie | Propietario ver | Propietario editar | Vendedor ver | Vendedor editar |
|---|---|---|---|---|
| Ajustes → Agenda → Recordatorios (plantilla, horas, variables) | sí | sí | no (403 API, oculto en UI) | no |
| Estado del recordatorio en cada cita (Citas) | sí | — | sí | — |
| Reintentar recordatorio fallido | sí | sí | sí | sí |
| Métricas oferta→cita / cita→asistencia | sí | — | no (403 API, oculto en UI) | — |

El guard de rol es **(nuevo)** y lo aporta la tarea 00. Hoy `withAuth`
(`src/lib/api.ts:17-37`) no distingue roles; `session.role` ya existe
(`src/lib/auth/session.ts:5-9`, `owner` al registrarse,
`src/server/auth/on-signup.ts:43`; Vendedor = `member`).

### Criterios de aceptación

1. **Dado** `AGENDA=on`, recordatorios activos con plantilla aprobada de 2
   variables y anticipación 24 h, **cuando** el operador agenda una cita para
   dentro de 25 h y el reloj llega a 24 h antes, **entonces** sale exactamente
   una plantilla al contacto, la cita muestra "Recordatorio 24 h: enviado" y
   luego "entregado" al llegar el webhook de estado.
2. **Dado** el mismo escenario, **cuando** se ejecutan dos ticks a la vez,
   **entonces** el outbox tiene una sola plantilla para esa cita.
3. **Dado** una cita agendada con recordatorio pendiente, **cuando** se cancela
   antes de la hora del recordatorio, **entonces** no se envía nada.
4. **Dado** un recordatorio de 24 h ya enviado, **cuando** se reprograma la cita
   a 3 días después, **entonces** el nuevo recordatorio sale 24 h antes de la
   hora nueva y el anterior queda como historial.
5. **Dado** una conversación del Laboratorio que agenda una cita de prueba,
   **cuando** corre el ticker, **entonces** no hay fila en `booking_reminder` ni
   mensaje en el outbox.
6. **Dado** que Meta rechaza el envío, **cuando** corre el ticker, **entonces** la
   cita muestra "Recordatorio fallido: <motivo>" con botón "Reintentar", y la
   cita sigue `agendada`.
7. **Dado** que la plantilla elegida pasó a `rejected` tras un sync
   (`syncTemplates`, `templates.ts:214-236`), **cuando** vence un recordatorio,
   **entonces** queda `skipped / template_not_approved` y Ajustes muestra un
   aviso; la agenda opera normal.
8. **Dado** un Vendedor, **cuando** pide `GET /api/bookings/metrics` o `PUT` de
   recordatorios, **entonces** recibe 403; con `AGENDA` apagada, 404 para
   cualquiera.
9. **Dado** 10 conversaciones con oferta y 4 con cita de la IA en el rango,
   **cuando** el Propietario abre métricas, **entonces** ve 40 % oferta→cita.
10. **Dado** que el proceso muere tras reclamar un recordatorio y antes de
    enviarlo, **cuando** reinicia, **entonces** el recordatorio queda `failed /
    interrumpido` (no se reenvía solo) y se puede reintentar a mano.

### Casos borde y degradación

- **Cita creada dentro de la ventana** (p. ej. a 3 h con anticipación 24 h): el
  de 24 h no aplica (`due < created_at`); no se crea fila. Si hay un segundo
  recordatorio de 2 h, ese sí sale.
- **Servidor caído durante el vencimiento**: al volver, se envía solo si sigue
  dentro de la gracia (24 h → 6 h; 2 h → 30 min) y faltan > 15 min; si no, no
  se envía ("mañana a las 10" con 40 min de margen confunde).
- **Reprogramar de vuelta a la hora original**: la clave
  `(booking, offset, scheduled_for)` ya existe → no se reenvía (aceptado).
- **El Propietario cambia las anticipaciones después de enviar** (p. ej. 24 h →
  23 h): la clave nueva produciría un segundo aviso casi seguido. Mecanismo:
  antes de reclamar, si la cita ya tiene tantos `sent` para su
  `scheduled_for` como anticipaciones configuradas, no se envía más (tope duro
  por cita = nº de anticipaciones, máx. 2).
- **Contacto de Instagram/Messenger** → `skipped / channel_not_whatsapp`.
- **Sin teléfono ni BSUID** (`templates.ts:355-363`) → `failed / no_recipient`.
- **Número desconectado / `reconnect_required`** → `skipped` con motivo; el
  ticker no reintenta en bucle (la clave única lo impide).
- **Plantilla con variable `meeting_link` y cita sin enlace** (`enlace-fijo` sin
  sala o `link_pending`): se usa el texto de respaldo.
- **Ventana de 24 h abierta**: se manda igual la plantilla (comportamiento
  predecible; las plantillas de utilidad dentro de ventana no tienen costo
  adicional según la tarifa vigente de Meta — confirmar, D-10-05).
- **Meta reclasifica la plantilla de UTILITY a MARKETING** al aprobarla
  (`templates.ts:222-224`): Ajustes muestra la categoría real y advierte el
  costo.
- **Muchas citas vencidas a la vez**: el tick procesa en serie con tope por
  vuelta (p. ej. 50) y sigue en el siguiente.
- **Hot reload en dev** re-ejecuta `register()`: el ticker se guarda en un
  símbolo global para no duplicar intervalos.
- **Respuesta del cliente "cancelo"**: el agente hace handoff (regla actual); la
  cita la cancela una persona. Con IA apagada, llega a la Bandeja como mensaje
  normal.

## 2. Plan técnico

### Estado actual (qué existe hoy, con rutas:línea)

- Bandera y respuesta 404: `src/server/agenda/flag.ts:40-51`.
- Tabla `booking` con `status` `agendada|realizada|no_show|cancelada`,
  `is_test`, `conversation_id` nullable, `created_at`:
  `src/lib/db/schema.ts:702-772`. No hay columnas de recordatorio.
- `offered_slot` (`schema.ts:783-799`) es **efímera**: `replaceOffers` borra la
  oferta anterior en cada ronda (`src/server/agenda/offers.ts:17-44`) y
  `clearOffers` la borra al reservar (`src/server/agenda/service.ts:222`,
  `:417`). **No sirve como denominador** de métricas.
- Llamadores de `replaceOffers`: `src/server/agenda/agent.ts:61`,
  `src/app/api/bot/availability/route.ts:87`, `service.ts:642` (re-oferta).
- Citas de agente y bot nacen con `source='ai'` (`agent.ts:84`,
  `src/app/api/bot/bookings/route.ts:50`).
- Servicio: crear `service.ts:83-250`, reprogramar `:289-348`, cancelar
  (idempotente) `:422-444`, marcar `realizada/no_show` `:446-469`.
- Configuración de agenda: tabla `calendar_settings` `schema.ts:670-696`;
  lectura/upsert `src/server/agenda/settings.ts:67-187`; ruta
  `src/app/api/calendar/settings/route.ts:22-76`; UI
  `src/components/settings/agenda-client.tsx` (cards en `:169`, `:242`,
  `:303`, `:351`, `:384`).
- Envío de plantilla aprobada: `sendTemplate`
  `src/server/whatsapp/templates.ts:273-415` (exige `conversationId`, valida
  `approved`, número exacto de variables, guard `is_test`, solo WhatsApp,
  inserta `message` con `origin='template'`).
- Estado de entrega: `applyStatusUpdate` `src/server/inbox/status.ts:25-67`
  (monotónico, guarda `error`).
- Ventana 24 h: `src/server/inbox/window.ts:10-16`.
- Listado de citas: `listBookings` `src/server/agenda/queries.ts:30-72`; UI
  `src/components/bookings/bookings-client.tsx` (badges `:182-197`, acciones
  `:234-281`, SSE `:54`).
- Rutas: `src/app/api/bookings/route.ts`, `src/app/api/bookings/[id]/route.ts`
  (PATCH con `reschedule|cancel|status|retry_link`, `:16-24`).
- **No hay scheduler**: el único hook de arranque es `register()` en
  `src/instrumentation.ts:6-11` → `cleanupOrphanRuns`
  (`src/instrumentation-node.ts:8-29`). Ningún `setInterval` de dominio
  (solo el heartbeat SSE, `src/app/api/events/route.ts:48`).
- Patrón de claim atómico ya usado: `src/server/attribution/conversions.ts:311-325`.
- Prefijos de ids: `src/lib/db/ids.ts:6-32`.
- Mocks: `wa-mock` responde plantillas y valida 132000
  (`src/app/api/dev/wa-mock/graph/[...path]/route.ts:285-339`); el disparador de
  falla `-down` solo existe para IG/Messenger (`:259-263`).
- Agente: regla "cancelar → handoff" `src/server/ai/prompts.ts:47`.

### Cambios de datos

Migración **NNNN** = siguiente libre al implementar (hoy sería `0013`; si 08 se
implementa antes, se intercambian). Aditiva y re-ejecutable (`IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`). Se aplica siempre, con la bandera encendida o
apagada (ADR-001).

1. `calendar_settings` (columnas nuevas):
   - `reminder_enabled boolean NOT NULL DEFAULT false`
   - `reminder_template_id text NULL REFERENCES template(id) ON DELETE SET NULL`
   - `reminder_offsets_minutes jsonb NOT NULL DEFAULT '[1440]'`
   - `reminder_variables jsonb NOT NULL DEFAULT '[]'` — p. ej.
     `["contact_name","booking_datetime"]` (índice = `{{n}}`−1)
2. `booking_reminder` **(nuevo)**, prefijo `brm`:
   - `id text PK`, `organization_id text NOT NULL → organization ON DELETE CASCADE`
   - `booking_id text NOT NULL → booking ON DELETE CASCADE`
   - `offset_minutes integer NOT NULL`, `scheduled_for timestamp NOT NULL`
     (copia de `booking.scheduled_at` al reclamar)
   - `status text NOT NULL` ∈ `sending|sent|failed|skipped`
   - `reason text NULL` (catálogo de `skipped`), `error text NULL`
   - `template_id text NULL → template ON DELETE SET NULL`
   - `message_id text NULL → message ON DELETE SET NULL`
   - `attempts integer NOT NULL DEFAULT 1`, `claimed_at timestamp NOT NULL DEFAULT now()`,
     `sent_at timestamp NULL`, `created_at`, `updated_at`
   - `UNIQUE (booking_id, offset_minutes, scheduled_for)` ← claim/idempotencia
   - `INDEX (organization_id, status, claimed_at)`
3. `agenda_offer_log` **(nuevo)**, prefijo `aol`:
   - `id text PK`, `organization_id text NOT NULL → organization ON DELETE CASCADE`
   - `conversation_id text NOT NULL → conversation ON DELETE CASCADE`
   - `is_test boolean NOT NULL DEFAULT false`, `slot_count integer NOT NULL`,
     `offered_at timestamp NOT NULL DEFAULT now()`
   - `INDEX (organization_id, offered_at)`, `INDEX (conversation_id)`
4. `src/lib/db/ids.ts`: prefijos `bookingReminder: "brm"`, `agendaOfferLog: "aol"`.

Toda lectura/escritura con `scoped()` (`src/lib/db/tenant.ts`). Excepción
justificada: el ticker obtiene primero la lista de organizaciones con
`reminder_enabled=true` (consulta sin sesión, solo ids) y a partir de ahí
**cada** query va `scoped()` por organización.

### Servidor

- `src/server/agenda/settings.ts`: extender `CalendarSettings`,
  `DEFAULT_CALENDAR_SETTINGS`, `getSettings`, `upsertSettings` con los 4 campos;
  validación de plantilla aprobada + variables completas en un helper
  `validateReminderConfig` (lanza `CalendarSettingsError`).
- `src/app/api/calendar/settings/route.ts`: ampliar `putSchema`; los campos de
  recordatorio solo los puede escribir el Propietario (guard de 00). El GET
  devuelve además la plantilla elegida (nombre, idioma, categoría, estado,
  nº de variables) para la UI.
- `src/server/agenda/reminders.ts` **(nuevo)**:
  - `dueReminders(orgId, now)` → candidatos según RF-10-04 (query `scoped`,
    `kind='session'`, `status='agendada'`, `is_test=false`, rango de
    `scheduled_at` acotado por la anticipación mayor, y `NOT EXISTS` de una
    fila con la misma `(booking_id, offset_minutes, scheduled_for)` para no
    re-intentar el INSERT en cada tick).
  - `renderReminderVariables(booking, contact, settings, orgName)` → `string[]`
    con respaldo para enlace vacío.
  - `claimReminder(...)` → `INSERT … ON CONFLICT DO NOTHING RETURNING`.
  - `sendReminder(row)` → resuelve conversación (RF-10-08), llama
    `sendTemplate`, traduce `TemplateError`/`SendError`/`MetaApiError` a
    `failed|skipped` con motivo; nunca relanza.
  - `recoverStuckReminders(now)` → `sending` > 10 min → `failed/interrumpido`.
  - `retryReminder(orgId, reminderId)` → claim condicionado `failed→sending`.
  - `runReminderTick(now)` → orgs con recordatorios → por org: recover, due,
    claim, send (en serie, tope 50 por vuelta); publica `booking.updated`.
- `src/server/agenda/reminder-ticker.ts` **(nuevo)**: `startReminderTicker()` con
  `setInterval(…, AGENDA_REMINDER_TICK_MS ?? 60_000)`, `timer.unref()`, guard en
  `globalThis[Symbol.for("vocero.reminderTicker")]`, flag `inFlight` (un tick a
  la vez por proceso), `try/catch` total (un tick fallido solo loguea). No
  arranca si `!agendaEnabled()` o `AGENDA_REMINDER_TICK_MS=0`.
- `src/instrumentation.ts` / `src/instrumentation-node.ts`: llamar
  `startReminderTicker()` después de `cleanupOrphanRuns()`.
- `src/lib/env.ts` + `.env.example`: `AGENDA_REMINDER_TICK_MS` (opcional, guía
  inline). Sin credenciales nuevas.
- `src/server/agenda/offers.ts`: tras la transacción de `replaceOffers` (no dentro: un fallo del log no debe revertir la oferta),
  insertar en `agenda_offer_log` con `try/catch` + `console.warn` (lee `is_test` de la conversación). Si
  `slots.length === 0` no se registra.
- `src/server/agenda/queries.ts`: `listBookings` agrega `reminders[]` (join a
  `booking_reminder` filtrado por `scheduled_for = booking.scheduled_at` + join a
  `message.status/error`).
- `src/server/agenda/metrics.ts` **(nuevo)**: `bookingMetrics(orgId, from, to)`
  (RF-10-15) con SQL agregada `scoped`.
- Rutas nuevas:
  - `PATCH /api/bookings/[id]` acción nueva `retry_reminder` con
    `reminderId` (en `src/app/api/bookings/[id]/route.ts`, Propietario y
    Vendedor).
  - `GET /api/bookings/metrics` **(nuevo)** — solo Propietario; 404 sin `AGENDA`.
  - `POST /api/dev/reminders/tick` **(nuevo)** tras `src/lib/dev-guard.ts` (404 en
    producción) — fuerza un tick con `now` opcional para el E2E.
- `wa-mock`: disparador de falla para envíos de WhatsApp (p. ej. token que
  termina en `-down` también en la rama `to`, o plantilla cuyo nombre empieza
  con `falla_`) en `src/app/api/dev/wa-mock/graph/[...path]/route.ts`.

### UI

- `src/components/settings/agenda-client.tsx`: card nueva **"Recordatorios"**
  (solo Propietario): switch, selector de plantilla (solo `approved`, muestra
  categoría y advertencia si es MARKETING), 1–2 anticipaciones en horas, un
  selector de campo por cada `{{n}}` con vista previa renderizada
  (`renderBody`), aviso si la plantilla dejó de estar aprobada. Si no hay
  plantillas aprobadas: enlace a Ajustes → Plantillas.
- `src/components/bookings/bookings-client.tsx`: por cita `session`, chips
  "Recordatorio 24 h: enviado · leído" / "pendiente (sale el 12/10 10:00)" /
  "fallido: motivo" + botón "Reintentar"; badges en la fila de `:182-197`.
- Métricas (solo Propietario): en la pantalla "Reportes" de la tarea 02; si 02
  no existe aún, card plegable al inicio de Citas visible solo para el
  Propietario (D-10-06).

### Tareas ordenadas

- [x] T-10-01 Enmendar `specs/015-motor-agenda-universal/spec.md:544`,
      `plan.md:79` y `tasks.md:188` (recordatorios pasan a post-v1 "10") y
      registrar decisión en un ADR corto o en `docs/agenda-conectores.md`.
- [x] T-10-02 Schema + migración **0018** (3 cambios de datos) + prefijos en `ids.ts`;
      `pnpm db:generate`, revisar SQL re-ejecutable. *(10-0: contrato)*
- [x] T-10-00 Contrato 10-0: DTOs (`src/lib/reminders.ts`, `src/lib/reports.ts`),
      firmas con reloj inyectable (`src/server/agenda/reminders.ts`), rutas con
      guarda definitiva y cuerpo 501, `ROUTE_POLICY`, `failSends` del wa-mock.
      Ver «Contrato 10-0» abajo.
- [x] T-10-03 `settings.ts` + ruta de settings: campos, validación, guard de
      Propietario (de 00).
- [x] T-10-04 `agenda_offer_log` en `replaceOffers` (después de la transacción,
      sin romper la oferta si falla).
- [x] T-10-05 `reminders.ts`: elegibilidad, variables, claim, envío, recover,
      retry.
- [x] T-10-06 `reminder-ticker.ts` + enganche en `instrumentation*.ts` + env.
- [x] T-10-07 `listBookings` con recordatorios; reintento manual.
      *(10-0: DTO `reminders[]` aditivo — vacío hasta 10-A — y ruta
      `POST /api/bookings/[id]/reminders/[reminderId]/retry` en 501.)*
- [x] T-10-08 Métricas en `GET /api/reports/bookings` (Propietario).
      *(10-0: DTO `BookingReportDto` y ruta con guardas en 501.)*
- [x] T-10-09 Dev: `POST /api/dev/reminders/tick` + disparador de falla en wa-mock.
      *(10-0: el disparador `fail-sends` ya funciona; el tick responde 501
      hasta que 10-A implemente `runReminderTick`.)*
- [ ] T-10-10 UI Ajustes (card Recordatorios).
- [ ] T-10-11 UI Citas (chips + reintentar) y métricas (Reportes o card).
- [x] T-10-12 Unit tests (abajo).
- [x] T-10-13 E2E `scripts/e2e-recordatorios.mjs` + guion
      `tests/e2e/us-recordatorios.md`; enganchar en `pnpm test:e2e`.
      *(10-A: escrito y `node --check`; `pnpm test:e2e` cubre bandera y
      superficies (`recordatoriosChecks`). Falta correrlo en vivo.)*
- [x] T-10-14 Doc: `docs/agenda-conectores.md` (sección recordatorios) y
      `.env.example`.

### Pruebas

**Unit (`tests/unit/`)**
- `reminders-eligibility.test.ts`: `due < created_at` → no; dentro/fuera de
  gracia; < 15 min → no; `cancelada`/`realizada`/`no_show` → no; reprogramada →
  nueva clave.
- `reminders-idempotency.test.ts`: dos `claimReminder` concurrentes → uno gana
  (simular 23505 / `ON CONFLICT`); `recoverStuckReminders` no reenvía.
- `reminders-sandbox.test.ts`: cita `is_test` no entra al tick; si se fuerza,
  `sendTemplate` lanza `sandbox_violation` (extiende el estilo de
  `tests/unit/agenda-sandbox.test.ts`, `send-sandbox.test.ts`).
- `reminders-variables.test.ts`: mapeo completo, enlace vacío → respaldo,
  plantilla con N variables vs mapeo incompleto → 422.
- `reminders-flag.test.ts`: ticker no arranca con `AGENDA` apagada ni con
  `AGENDA_REMINDER_TICK_MS=0` (estilo `agenda-flag.test.ts`).
- `booking-metrics.test.ts`: oferta→cita y asistencia con fixtures, excluye
  `is_test`.

**E2E (`scripts/e2e-recordatorios.mjs` + `tests/e2e/us-recordatorios.md`)**, BD
aislada (`.env.e2e`), `WA_MOCK_ENABLED=true`, `AGENDA=on`,
`AGENDA_REMINDER_TICK_MS=0` (ticks solo por el endpoint dev):
1. Conectar número mock, crear plantilla de 2 variables y aprobarla
   (`/api/dev/wa-mock/template-status`), sincronizar.
2. Ajustes: activar recordatorios con 1440 min → 200; con plantilla `pending` →
   422.
3. Inbound de un contacto; agendar cita manual en un hueco de
   `/api/calendar/availability` que esté a ≥ 25 h (así `due ≥ created_at`);
   `DELETE /api/dev/wa-mock/outbox`. Tick con `now = scheduled − 24 h − 5 min` →
   nada (aún no vence).
4. `POST /api/dev/reminders/tick` con `now = scheduled − 24 h + 1 min`, dos
   veces en paralelo → outbox con **una**
   plantilla `type:"template"`, parámetros correctos; la cita muestra
   `sent`; webhook de estado `delivered` (`/api/dev/wa-mock/status`) → la cita
   muestra entregado.
5. Reprogramar → tick con `now` en la nueva ventana → segunda plantilla.
6. Cancelar otra cita con recordatorio pendiente → tick → nada.
7. Sandbox: el ai-mock del agente nunca emite `offer_slots`/`book_slot`
   (`src/server/dev/ai-mock.ts:46-71`), así que la cita de prueba se crea a mano:
   tomar un `conversationId` de `GET /api/lab/runs/[id]` (`cases[].conversationId`)
   y hacer `POST /api/bookings` `kind:"session"` con ese `conversationId` en un
   hueco ≥ 25 h → nace `is_test=true` (`service.ts:111-129`) → tick con `now` en
   su ventana → sin fila en `booking_reminder` y outbox sin plantillas.
8. **Camino infeliz**: disparador de falla → `failed` con motivo, la cita sigue
   `agendada`; "Reintentar" con mock sano → `sent`. Plantilla pasada a
   `rejected` → `skipped/template_not_approved`.
9. Métricas: como Propietario 200 con números esperados; como Vendedor 403
   (cuando 00 exista).
10. **Apagado**: con `AGENDA` apagada, `GET /api/bookings/metrics`,
    `POST /api/dev/reminders/tick` y PATCH `retry_reminder` → 404; el ticker no
    registra filas.

### Riesgos y decisiones abiertas

- **D-10-01 Dónde corre el reloj**: propuesta = ticker in-process (único hook:
  `instrumentation.ts`). Alternativa: además, un endpoint autenticado
  (`BOT_API_KEY` o secreto propio) para que un cron externo del host lo llame
  (como sugería la spec 015 para el fork). ¿Solo in-process, o ambos?
- **D-10-02 Garantía**: a-lo-sumo-una-vez (propuesta; un `sending` interrumpido
  no se reenvía solo) vs al-menos-una-vez (riesgo de duplicado al cliente).
- **D-10-03 Variables**: mapeo por posición en Ajustes (propuesta) vs convención
  fija `{{1}}` nombre / `{{2}}` fecha-hora / `{{3}}` enlace (más simple, menos
  flexible).
- **D-10-04 Botones Confirmar/Cancelar (fase 2)**: requiere (a) soportar
  componente `BUTTONS` tipo `QUICK_REPLY` en `createTemplate`
  (`templates.ts:106-114`) y en el wa-mock, (b) ingerir mensajes `button` en
  `ingest.ts` (agregar a `SUPPORTED_TYPES` y mapear `payload`), (c) acción
  "confirmar" (¿columna `booking.confirmed_at`?) y "cancelar" automática o con
  handoff. ¿Entra en esta tarea o en una 10b?
- **D-10-05 Costos de Meta**: plantilla siempre (propuesta) vs texto libre si
  la ventana de 24 h está abierta. Confirmar tarifa vigente de plantillas de
  utilidad dentro de ventana antes de decidir.
- **D-10-06 Dónde viven las métricas** si 02 (Reportes) no está hecha: card solo
  Propietario en Citas (propuesta) o esperar a 02.
- **D-10-07 Denominador de oferta→cita**: tabla append-only `agenda_offer_log`
  (propuesta) vs dejar de borrar `offered_slot` (agrega `superseded_at`, pero
  toca la regla innegociable "solo se reserva lo ofrecido vigente").
- **Riesgo réplicas**: el claim por UNIQUE hace seguro correr N tickers; pero
  `cleanupOrphanRuns` (`instrumentation-node.ts:8-29`) marca como fallidas
  las corridas del Laboratorio de OTRAS réplicas al arrancar — no es de esta
  tarea, se anota.
- **Riesgo reloj/zona**: la etiqueta de fecha usa `settings.timezone`; si el
  negocio cambia de zona, los recordatorios ya enviados no cambian (correcto).
- **Riesgo calidad de plantilla**: muchos recordatorios ignorados pueden bajar
  la calidad del número en Meta; mantener 1–2 por cita como tope duro.

## Contrato 10-0

Fijado para que servidor (10-A) y UI (10-B) avancen en paralelo. **Manda sobre
el plan técnico** donde difieran (rutas de métricas y reintento, estados,
`reminder_enabled_at`, tope de reintentos).

### Decisiones cerradas

| # | Decisión |
|---|---|
| D-10-01 | Reloj in-process: `setInterval` arrancado desde `instrumentation` (10-A), más `POST /api/dev/reminders/tick` para forzar una vuelta con reloj simulado. Sin endpoint para cron externo. |
| D-10-02 | Envío interrumpido (`sending` > 10 min) → `failed / interrumpido`; jamás se reenvía solo. Reintento manual **a lo sumo una vez** (`attempts` 1 → 2). |
| D-10-03 | Variables de plantilla mapeadas por posición en Ajustes (catálogo cerrado). |
| D-10-04 | Botones Confirmar/Cancelar: fase 2, fuera. |
| D-10-05 | Siempre plantilla aprobada (aunque la ventana de 24 h esté abierta). |
| D-10-06 | Métricas en Reportes: `GET /api/reports/bookings`, con `parseReportRange`, `reportTimezone` y `runBlocks`/`runReadOnly` de `src/server/reports/run.ts`. Solo Propietario. |
| D-10-07 | Tabla append-only `agenda_offer_log`. |
| nueva | **`reminder_enabled_at`**: al encender, solo se avisan recordatorios con momento de envío (`scheduled_at − offset`) ≥ esa fecha. Sin ráfaga sobre citas ya agendadas. Se escribe (con el `now` de JS) en cada transición apagado → encendido; apagar no lo borra. |

Todo detrás de `AGENDA`: apagada ⇒ el ticker no arranca y toda superficie de
esta tarea responde **404 sin cuerpo** (también la ruta dev y el reporte).

### Datos — migración `0018_recordatorios_citas.sql`

- `calendar_settings` + `reminder_enabled boolean NOT NULL DEFAULT false`,
  `reminder_enabled_at timestamp NULL`, `reminder_template_id text NULL →
  template ON DELETE SET NULL`, `reminder_offsets_minutes jsonb NOT NULL
  DEFAULT '[1440]'`, `reminder_variables jsonb NOT NULL DEFAULT '[]'` (índice =
  `{{n}} − 1`).
- `booking_reminder` (prefijo `brm`): `organization_id` (FK cascade),
  `booking_id` (FK cascade), `offset_minutes`, `scheduled_for` (= hora de la
  cita, `timestamp` sin zona como `booking.scheduled_at`), `status`, `reason`,
  `error`, `template_id` (FK set null), `message_id` (FK → `message`, set
  null; de aquí sale la entrega), `wa_message_id` (copia cruda), `attempts`
  (default 1), `claimed_at` **NOT NULL sin default** (lo pone JS), `sent_at`,
  `created_at`, `updated_at`. `UNIQUE booking_reminder_claim_uq (booking_id,
  offset_minutes, scheduled_for)` = claim atómico. Índice `(organization_id,
  status, claimed_at)`.
- `agenda_offer_log` (prefijo `aol`): `organization_id` (FK cascade),
  `conversation_id` (FK cascade), `is_test`, `slots jsonb` (ISO-8601 UTC en el
  orden mostrado), `slot_count`, `created_at` (= hora de la ronda; la pone JS).
  Índices `(organization_id, created_at)` y `(conversation_id)`. Nadie
  actualiza ni borra.

### Estados de `booking_reminder.status`

| Estado | Quién lo escribe | Significado |
|---|---|---|
| `pending` | **nadie en BD** (fase 1) | El DTO lo sintetiza para una anticipación sin fila; `id = null`, con `dueAt`. |
| `sending` | claim del tick (`INSERT … ON CONFLICT DO NOTHING RETURNING`) o del reintento (`UPDATE … WHERE status='failed' AND attempts <= 1 RETURNING`) | Envío en curso. |
| `sent` | tras `sendTemplate` OK | `message_id`, `wa_message_id`, `sent_at`. Entrega por join a `message.status/error`. |
| `failed` | `SendError`/`MetaApiError` (`error` = mensaje legible) o `recoverStuckReminders` (`error = 'interrumpido'`) | Reintentable a mano una vez. |
| `skipped` | config. inválida al vencer | `reason` ∈ `template_not_approved`, `template_missing`, `channel_not_whatsapp`, `not_connected`, `reconnect_required`, `no_recipient`. No se reintenta. |

### Reglas (10-A)

1. **Elegibilidad** = consulta (`kind='session'`, `status='agendada'`,
   `is_test=false`, org con `reminder_enabled=true`, sin fila para la terna) +
   `reminderTiming(input, now) === null` (`src/lib/reminders.ts`, pura, ya
   implementada): `due ≥ reminder_enabled_at`, `due ≥ booking.created_at`,
   `due ≤ now ≤ due + gracia`, `now ≤ scheduled_at − 15 min`.
   Gracia `= min(offset/4, 6 h)`. Tope duro: si la cita ya tiene tantos `sent`
   para su `scheduled_for` como anticipaciones configuradas, no se reclama más.
2. **Sandbox**: filtro `is_test=false` en la consulta (jamás fila) + `sendTemplate`
   lanza `SendError("sandbox_violation")` como segunda barrera. No se toca.
3. **Cancelar / `realizada` / `no_show`** sacan la cita de la consulta: no sale
   nada después. **Reprogramar** cambia `scheduled_at` ⇒ clave nueva ⇒
   recordatorios nuevos; los anteriores quedan como historial (el DTO solo
   muestra los de la hora vigente).
4. **Conversación destino**: `booking.conversation_id`; si es null, la
   conversación real del contacto o `getOrCreateConversation`.
5. **Variables**: `contact_name`, `booking_datetime` (`labelInTz` en la zona
   del negocio), `meeting_link` (vacío → `MEETING_LINK_FALLBACK`),
   `business_name`. Nunca un parámetro vacío.
6. **Reloj inyectable**: ninguna función de la lógica usa `now()` de SQL;
   `claimed_at`, `sent_at`, `updated_at` y `reminder_enabled_at` salen del
   `now: Date` recibido.
7. Cada cambio de fila publica `booking.updated` (SSE). Nada de esto lanza
   hacia la agenda (RF-10-16). Ticker: lote `REMINDER_TICK_BATCH = 50` por org,
   en serie; `AGENDA_REMINDER_TICK_MS` (default 60 000; `0` = no arranca);
   guard en `globalThis` contra hot reload.
8. `agenda_offer_log`: insertar después de la transacción de `replaceOffers`,
   en try/catch; con 0 slots no se registra.

### Firmas (`src/server/agenda/reminders.ts`)

```ts
// re-exportadas de src/lib/reminders.ts (reales)
REMINDER_STUCK_AFTER_MS = 10 min · REMINDER_MIN_LEAD_MS = 15 min
REMINDER_MAX_GRACE_MS = 6 h · REMINDER_TICK_BATCH = 50
REMINDER_TICK_DEFAULT_MS = 60_000 · REMINDER_MAX_MANUAL_RETRIES = 1
reminderGraceMs(offsetMinutes): number
reminderDueAt(scheduledAt: Date, offsetMinutes): Date
reminderTiming(input: ReminderTimingInput, now: Date): null | "not_enabled"
  | "before_enabled" | "before_created" | "not_due" | "grace_expired" | "too_close"

// stubs (lanzan ReminderNotImplementedError → las rutas responden 501)
runReminderTick(now: Date): Promise<ReminderTickResultDto>
recoverStuckReminders(now: Date, organizationId?: string): Promise<number>
retryReminder({ organizationId, bookingId, reminderId, now }): Promise<BookingReminderDto>
  // lanza ReminderError: not_found 404 · not_retryable / retry_exhausted / booking_not_active 409
remindersForBookings(orgId, bookingIds, now): Promise<Map<string, BookingReminderDto[]>>  // hoy: Map vacío

// real
getReminderSettings(orgId): Promise<ReminderSettingsDto>

// src/server/reports/bookings.ts (stub)
bookingReport(orgId, range: ReportRange, now: Date): Promise<BookingReportDto>
```

### Rutas

| Ruta | Política | Cuerpo / query | 200 | Errores |
|---|---|---|---|---|
| `GET /api/calendar/settings` | owner | — | `{ settings, reminders: ReminderSettingsDto }` | 404 AGENDA off |
| `PUT /api/calendar/settings` | owner | lo de siempre + `reminderEnabled?`, `reminderTemplateId?` (string\|null), `reminderOffsetsMinutes?` (1–2 enteros únicos, 60..4320), `reminderVariables?` (`ReminderField[]`) | `{ settings, reminders }` | 422 `invalid_body` (forma; y en 10-A: plantilla no `approved`/no WhatsApp o mapeo incompleto, con mensaje) |
| `GET /api/bookings` | any | — | cada cita con `reminders: BookingReminderDto[]` (aditivo) + `businessTimezone: string` (zona del negocio, aditivo 10-A: el Vendedor no lee los ajustes) | 404 AGENDA off |
| `POST /api/bookings/[id]/reminders/[reminderId]/retry` | any | sin cuerpo | `{ ok: true, reminder: BookingReminderDto }` (ya resuelto tras el envío síncrono) | 404 `not_found` · 409 `not_retryable` · 409 `retry_exhausted` · 409 `booking_not_active` · 404 AGENDA off |
| `GET /api/reports/bookings` | owner | rango de Reportes (`range`, `from`, `to`) | `BookingReportDto` (`src/lib/reports.ts`): `range` + bloques `offers`, `attendance`, `byReminder` | 403 Vendedor · 422 `invalid_range` · 503 `report_timeout` · 404 AGENDA off |
| `POST /api/dev/reminders/tick` | dev | `{ now?: ISO }` (JSON obligatorio, `{}` vale) | `ReminderTickResultDto` `{ now, organizations, recovered, claimed, sent, failed, skipped }` | 404 sin mocks o AGENDA off · 422 |
| `GET/POST /api/dev/wa-mock/fail-sends` | dev | `{ mode: "off" \| "error" \| "down" }` | `{ failSends }` | — · **ya funciona**: `error` = 400 Meta 131026 → `meta_error`; `down` = 503 → `meta_unavailable`. Solo envíos de WhatsApp; `DELETE /api/dev/wa-mock/outbox` lo apaga. |

### DTOs

- `src/lib/reminders.ts` (re-exportados en `src/lib/types.ts`):
  `BookingReminderDto { id|null, offsetMinutes, scheduledFor, dueAt, status,
  reason, error, sentAt, attempts, canRetry, delivery, deliveryError }`,
  `ReminderSettingsDto { enabled, enabledAt, templateId, template:
  ReminderTemplateSummaryDto|null, offsetsMinutes, variables, warning:
  "template_missing"|"template_not_approved"|null }`,
  `ReminderSettingsInput`, `ReminderRetryResultDto`, `ReminderTickResultDto`,
  catálogos `BOOKING_REMINDER_STATUSES`, `BOOKING_REMINDER_SKIP_REASONS`,
  `REMINDER_FIELDS` (+ `REMINDER_FIELD_LABEL`), `MEETING_LINK_FALLBACK`,
  `REMINDER_OFFSET_LIMITS`, `REMINDER_MAX_OFFSETS`.
- `src/lib/reports.ts`: `BookingReportDto`, `OfferConversionDto
  { conversationsWithOffer, converted, rate, offerRounds, dataSince }`,
  `BookingAttendanceDto { realizada, noShow, rate, pendingToMark, cancelada }`,
  `AttendanceByReminderDto { withReminder, withoutReminder }` («con» = ≥ 1
  `sent` para la hora vigente). Proporciones 0..1, `null` con denominador 0.

## 3. Dependencias con otras tareas

- **00 — Roles y permisos** (bloqueante para los guards de Propietario en
  Ajustes y métricas; sin 00 todo miembro sería tratado como hoy).
- **02 — Métricas del agente**: provee la pantalla "Reportes" donde se montan
  las métricas de esta tarea (si no, D-10-06).
- **03 — Contexto del contacto para el agente** (deseable): que el agente vea la
  próxima cita del contacto mejora la respuesta al recordatorio ("¿a qué hora
  era?").
- **08 — Laboratorio por cliente**: comparte la numeración de migraciones
  (la que se implemente primero toma la siguiente libre). El sandbox de citas
  de prueba se mantiene en ambas.
- Independiente de 09/06/05.
