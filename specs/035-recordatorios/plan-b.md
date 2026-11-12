# 035 — Plan de la fase B (Avisos: campana, aviso emergente, navegador)

Contrato: [spec.md](spec.md) § Fase B · diseño aprobado: `diseno/Avisos.dc.html`.
Base: fase A en prod (`follow_up`, `/api/follow-ups…`).

## Modelo — `notification` (migración `0031_avisos.sql`, re-ejecutable)

`id` (`ntf_`), `organization_id` NOT NULL, `user_id` NOT NULL (destinatario,
cascade), `kind` (`follow_up_due|daily_summary|chat_assigned|booking_assigned`),
`follow_up_id` NULL (cascade), `conversation_id` NULL (cascade), `booking_id`
NULL (cascade), `contact_id` NULL (cascade), `actor_user_id` NULL (set null),
`payload` jsonb (instantánea para el texto: nombre del cliente, motivo, nota,
`due_at`, `scheduled_at`…), `dedupe_key` text NOT NULL, `read_at` NULL,
`created_at`.

- UNIQUE `(organization_id, user_id, dedupe_key)` → idempotencia y candado
  entre réplicas (`onConflictDoNothing().returning()` = solo los nuevos se
  publican).
- Índice `(organization_id, user_id, read_at, created_at desc)`.
- Claves DETERMINISTAS (el UNIQUE es el candado solo si lo son):
  `fu:<followUpId>:<dueAtISO>` (posponer = nueva hora = nuevo aviso),
  `daily:<YYYY-MM-DD>` (día de pared del negocio),
  `chat:<convId>:<toUserId>:<assignedAtISO>` (`assignConversation` agrega
  `assigned_at` a su `.returning`), `booking:<bookingId>:<toUserId>:<updatedAtISO>`.
- Retención: el reloj borra los leídos de más de 60 días.

## Quién genera cada aviso

| Aviso | Dónde | Regla |
|---|---|---|
| Recordatorio vencido | reloj `src/server/notifications/ticker.ts` (60 s, `NOTIFICATIONS_TICK_MS`, `0` apaga; patrón de `reminder-ticker.ts`) | `follow_up` abierto con `due_at <= now` sin aviso para ese `due_at` → aviso a `follow_up.user_id`. Solo vencidos de las últimas 24 h (no inundar al arrancar con históricos). |
| Resumen del día | mismo reloj | desde las 08:00 del negocio, 1 por usuario y día si tiene ≥1 abierto con `due_at` ≤ fin de hoy. El texto se calcula **en vivo** al listar («Hoy tienes N (M vencidos)»; con 0 → «Ya no te quedan recordatorios para hoy», atenuado). |
| Te asignaron a … (chat) | `POST /api/conversations/[id]/assign` | `changed` y `to ≠ null` y `to ≠ session.userId` (Propietario asigna a un vendedor). Tomar uno mismo / «responder = tomar» no avisa. |
| Te asignaron la cita de … | `createSessionBooking` (vendedor ≠ actor; IA/bot sin actor también avisan), `assignBooking`, `moveBooking` con `sellerChanged` | destinatario = nuevo vendedor, si ≠ actor. Nunca citas de conversaciones `is_test`. Sin actor (IA/bot): texto neutro «Se agendó la cita de Sofía Castro · mañana 12:00 · Ver cita». |

**Dónde se crea** (una sola vía, sin duplicar): chat y cita reasignada/movida →
en las **rutas** (`/api/conversations/[id]/assign`, `PATCH /api/bookings/[id]`),
que tienen `session` = actor; cita creada → dentro de `createSessionBooking`
después del commit (la IA y el bot no pasan por una ruta con sesión), usando
`input.actorUserId`.

**Alcance del Propietario** (supuesto a informar al publicar): su campana solo
trae SUS avisos (sus recordatorios, lo que le asignen); no recibe los
recordatorios vencidos de cada vendedor (esos los ve en Pendientes con el
filtro).

Todos se insertan **después del commit** (o fuera de la transacción de la
operación principal) y un fallo al avisar **nunca** tumba la operación: try/catch
+ log sin datos sensibles.

Al marcar un recordatorio Hecho o Posponerlo, su aviso `follow_up_due`
pendiente se marca leído.

## Tiempo real (SSE)

- Evento nuevo `notification.changed` `{ userId, reason: "new"|"read", notification? }`.
  Filtro en `canReceive` (el atajo síncrono, ANTES del pase libre del
  Propietario): se entrega **solo** si `viewer.userId === event.userId` (el
  Propietario no recibe avisos ajenos; test unitario de este caso). Mismo
  filtro para `follow_ups.changed` (`userIds.includes`). Se agrega a
  `SseEvent`, `SSE_EVENT_TYPES`, `HANDLER_FOR`, `EventHandlers`.
- Evento `follow_ups.changed` `{ userIds }` desde el store de follow-ups (crear,
  hecho, posponer) → al dueño del recordatorio se le refresca el número rojo y
  la línea de la Bandeja aunque lo haya cambiado el Propietario.
- Bus in-process: una sola réplica en Coolify (aceptado, igual que hoy).

## API (clasificar en `src/lib/permissions.ts`, todas `any*`)

| Ruta | Qué |
|---|---|
| `GET /api/notifications` | últimos 30 propios + `unread` + datos vivos del resumen y estado del recordatorio (abierto/hecho) |
| `POST /api/notifications/read` | `{ ids: string[] }` o `{ all: true }` (solo propios) |
| `GET /api/follow-ups/count` | se amplía a `{ overdue, today }` (today = abiertos con `due_at` ≤ fin de hoy, incluye vencidos) |
| `POST /api/dev/notifications/tick` (`dev`) | `{ now?: ISO }` corre una vuelta del reloj |

## UI

- **Campana** junto al nombre del negocio (`app-nav.tsx`, también en el
  encabezado móvil de `app-shell.tsx`; contraído: debajo de la inicial).
  Contador rojo de no leídos. Abre un panel «Avisos» (popover, Escape/clic fuera
  cierra, foco atrapado como diálogo no modal):
  - Recordatorio vencido: «**Recordatorio vencido:** Carlos Ruiz · Volver a
    contactar», nota y hora; botones **Contactar** (abre el chat como en
    Pendientes) y **Posponer ▾** (1 h · Mañana · 1 semana). Si ya se hizo:
    «Ya lo marcaste como hecho», sin botones.
  - Resumen del día con «Ver en Seguimiento › Pendientes».
  - «Te asignaron a Patricia Luna» · «Alejandro la pasó a tu nombre · hace
    20 min · Abrir chat».
  - «Te asignaron la cita de Sofía Castro · mañana 12:00» · «Ver cita».
  - No leídos con punto y fondo (rojo para vencido, verde para el resto); leídos
    «Leído · ayer». Clic o acción en uno = leído. «Marcar todo como leído».
  - Pie: «¿Quieres el aviso aunque estés en otra pestaña?» + «Activar avisos
    del navegador» (pide permiso; si ya está: «Avisos del navegador activados»
    · «Desactivar»; si el navegador los bloqueó, lo dice).
- **Aviso emergente** (abajo a la derecha, oscuro, `role="status"`) al llegar
  por SSE un `follow_up_due`: «Recordatorio: Laura Gómez», motivo · nota,
  **Posponer 1 h** · **Contactar** · ×. Se apilan máx. 3; se queda hasta que
  el usuario actúa o cierra. Solo en la pestaña que lo recibe (todas las
  pestañas abiertas lo muestran; es dentro del CRM).
- **Navegador**: si el usuario los activó y la pestaña está oculta, la pestaña
  líder (`alerts-coordinator`, `dedupeKey` = id del aviso) lanza
  `Notification` para `follow_up_due` y asignaciones. Preferencia por usuario y
  dispositivo en localStorage junto a las de `src/lib/alerts.ts`.
- **Bandeja** «Esto es lo que te toca ahora»: ítem nuevo `reminders` (tono
  acento) «N recordatorios para hoy (M vencidos)» · «Ábrelos en Seguimiento ›
  Pendientes.» → `/pipeline?vista=pendientes`. Solo si N > 0. Datos de
  `/api/follow-ups/count`.

## Pruebas

`.env.e2e` lleva `NOTIFICATIONS_TICK_MS=0`: en E2E el reloj solo corre vía
`POST /api/dev/notifications/tick` (un emergente espontáneo taparía clics en los
demás arneses). Las pruebas del resumen del día: SKIP cerca de medianoche y
con `now` forzado se valida que exista la fila, no su texto vivo.

Hecho = gate técnico + E2E verde + `tests/e2e/us-avisos.md` + capturas
revisadas contra `diseno/Avisos.dc.html`. Rama `035-b-avisos`.

- Unit: claves de dedupe, regla del resumen (08:00, día de pared), textos,
  `decideDelivery` del evento nuevo (Propietario no recibe ajenos),
  `summaryItems` con recordatorios, matriz de permisos.
- E2E `scripts/e2e-avisos.mjs` (BD aislada) conectado al self-test: vendedora
  crea recordatorio → tick con `now` posterior → campana con 1 y el aviso; con
  la página abierta el aviso emergente aparece en vivo; Posponer 1 h desde el
  emergente; Contactar abre el chat; segundo tick no duplica; otra vendedora y
  el Propietario no lo ven; Propietario asigna chat y cita → avisos «Te
  asignaron»; tomar uno mismo no avisa; Marcar todo como leído → contador 0;
  línea de la Bandeja; reloj falla → la app sigue.

## Ayuda (pedido del dueño, 12-nov)

- Tema nuevo `recordatorios` en `src/lib/help/topics.ts` (después de
  `contactos`) + `specs/031-guia-vendedores/contenido.md` § 5d: «Recordarme»,
  Pendientes, Sin contacto / Sin respuesta (fase A, ya escrito). Al cerrar B:
  bloque «Avisos» (campana, aviso emergente, «Activar avisos del navegador»)
  con los rótulos reales.
- Tema `plantillas`: el indicador de 033 («Plantilla enviada a …», «Ya le
  enviaste este mensaje…», «Enviar otra plantilla») — ya escrito.
- Capturas `pendientes.png`, `recordarme.png` (y la campana) con
  `scripts/ayuda-capturas.mjs` en la BD e2e reseteada; `captura` del tema +
  test de `help-topics` + revisión en `scripts/e2e-ayuda.mjs` (#recordatorios).
