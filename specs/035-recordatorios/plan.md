# 035 — Plan de la fase A (Recordatorios y Pendientes)

Contrato: [spec.md](spec.md) · diseño: `diseno/Main.dc.html` (Seguimiento ›
Pendientes) y `diseno/Recordarme.dc.html` (diálogo). La campana y los avisos
son de la fase B; la sugerencia al cerrar, de la C.

## Dominio y nombres (sin choque con los recordatorios de cita)

Los recordatorios de cita automáticos al cliente ya existen (`booking_reminder`,
`src/server/agenda/reminders.ts`, `scripts/e2e-recordatorios.mjs`). Esta
feature vive en otro dominio: tabla `follow_up` (prefijo `fu_`), servidor
`src/server/follow-ups/`, puro `src/lib/follow-ups.ts`, rutas
`/api/follow-ups…`, E2E `scripts/e2e-pendientes.mjs`. En pantalla se llaman
«recordatorios».

## Modelo — `follow_up` (migración `0030_recordatorios_pendientes.sql`)

`id`, `organization_id` NOT NULL, `contact_id` NOT NULL (cascade),
`conversation_id` NULL (set null; se puede crear desde Contactos sin chat),
`user_id` NOT NULL (dueño = quien lo crea), `due_at` (instante UTC, como
`booking.scheduled_at`), `reason` (`volver_a_contactar|servicio|informacion|cita|otro`),
`note`, `repeat_months` (NULL|3|6|12, CHECK), `status` (`open|done`), `done_at`,
`done_note`, `created_from` (`manual`; la fase C agrega otros), timestamps.

Índices: `(organization_id, user_id, status, due_at)` para la lista y el
contador del menú; `(organization_id, contact_id, status)` para el diálogo, el
cajón y «ya tiene recordatorio».

Re-ejecutable como la 0029: `IF NOT EXISTS`, FKs en `DO $$ … duplicate_object`,
`REFERENCES` sin esquema.

## Zona horaria

`due_at` se guarda en UTC. Todo se captura y se muestra en la zona del negocio
(`reportTimezone` = `calendar_settings.timezone` o `America/Mexico_City`), como
Citas. El cliente manda `day` (`YYYY-MM-DD`) + `time` (`HH:mm`) de pared y el
servidor convierte con `zonedWallClockToUtc`.

- **Repetir**: al marcar «Hecho» se cierra y, en la misma transacción, nace el
  siguiente con `due_at` = día de pared original + N meses (31 → 30/28/29), a
  la misma hora de pared, mismo motivo y nota.
- **Posponer** (mueve `due_at`, no crea otro): `1h` = ahora + 1 h; `tomorrow` =
  mañana (en la zona del negocio) a la hora de pared del recordatorio; `week` =
  hoy + 7 días a esa hora; u otra fecha y hora.
- **Grupos**: Vencidos = `due_at < ahora` (instante); Hoy = resto del día de
  hoy en la zona; **Esta semana = de mañana al domingo de esta semana de
  calendario (lunes–domingo, en la zona; un domingo queda vacía y no se
  muestra)**; Después = del lunes siguiente en adelante.

## Permisos

Todas las rutas `any*` (`withAuth` + filtro por rol en el store):

- Vendedor: solo los suyos (`user_id = él`); uno ajeno → 404.
- Propietario: ve todos con «Vendedor: Todos / …»; crea los suyos; puede
  marcar Hecho / posponer cualquiera (supervisa, como en Citas).

| Ruta | Qué |
|---|---|
| `GET /api/follow-ups` | abiertos (o `status=done`) por `contactId`, `userId` (Propietario) — con `businessTimezone` |
| `POST /api/follow-ups` | crear (`contactId`, `conversationId?`, `day`, `time`, `reason`, `note?`, `repeatMonths?`) |
| `PATCH /api/follow-ups/[id]` | `{action:"done", note?}` · `{action:"postpone", preset}` · `{action:"postpone", day, time}` |
| `GET /api/follow-ups/count` | `{ overdue }` propios (número rojo del menú) |
| `GET /api/follow-ups/pending` | «Sin contacto» y «Sin respuesta a tu plantilla» |

## «Sin contacto» y «Sin respuesta a tu plantilla»

Conjunto base: conversaciones reales (`is_test = false`), no archivadas
(conversación ni contacto), asignadas al vendedor. Propietario: «Todos»
incluye las sin asignar (en un negocio de una sola persona nadie asigna); un
vendedor concreto = las asignadas a él.

- **Sin contacto**: usa `conversation.last_message_at` (lo mantienen ingest,
  envío, plantillas, eco del teléfono, IA y leads externos; índice
  `conversation_org_last_idx`), con `coalesce(…, created_at)`. Una sola
  consulta: `last_message_at < ahora − N días` o entre Desde y Hasta (días de
  pared en la zona del negocio), `LEFT JOIN lead → pipeline_stage` para la
  etapa y para excluir `kind = 'lost'` (salvo «Incluir perdidos»), y un
  `LEFT JOIN LATERAL` al primer `follow_up` abierto del contacto para «recordatorio
  el 20 nov». Orden: el más antiguo primero. Nota: un envío que falla también
  actualiza `last_message_at` (cuenta como intento de contacto).
- **Sin respuesta a tu plantilla**: sobre el mismo conjunto, acotado por
  `last_message_at < ahora − N días`, un `LEFT JOIN LATERAL` al último mensaje
  de la conversación (`message_org_conv_idx`, top-1) y se queda con los
  salientes `origin = 'template'` y `status <> 'failed'`. Nombre de la
  plantilla con `matchTemplateByText` contra las de la organización.

Sin N+1: dos consultas por pantalla, más la de plantillas.

## UI

- `/pipeline?vista=pendientes`: selector «Tablero | Pendientes» en el
  encabezado (la URL se enlaza desde el menú más adelante). El tablero no
  cambia.
- Pendientes: «Mis recordatorios» (filtro por motivo con contadores; Vencidos y
  Hoy completos, Esta semana y Después plegados; Contactar · Hecho con «¿Qué
  pasó?» y aviso de repetición · Posponer ▾), y a la derecha «Sin contacto» y
  «Sin respuesta a tu plantilla» (3 a la vista y «Ver los N (del más antiguo
  al más reciente)» con desplazamiento interno, máx. ~8 filas). Propietario:
  «Vendedor: Todos / …».
- «Contactar» → `/inbox?contact=…` si hay chat; sin chat → «Escribir primero»
  a `/contacts?q=<nombre>`.
- Diálogo «Recordarme»: encabezado del chat (junto a «Agendar», sin bandera),
  cajón del trato en Seguimiento y fila de Contactos. Atajos Mañana · En 3
  días · En 1 semana · En 1 mes, 10:00 hora del negocio por defecto; abajo los
  abiertos de ese cliente.
- Cajón del trato: sección «Recordatorios» con los hechos y su «¿Qué pasó?».
- Menú: número rojo de vencidos junto a «Seguimiento» (`/count` al montar, al
  navegar, cada 2 min y al cambiar un recordatorio).

## Pruebas

Unit (`tests/unit/follow-ups.test.ts`): repetir/posponer (fin de mes, año
bisiesto, cambio de año), grupos en la zona del negocio, Zod. Matriz de
permisos. E2E `scripts/e2e-pendientes.mjs` (BD aislada) + `pendientesChecks()`
en `scripts/e2e-selftest.mjs`.
