# Contrato: Canal SSE de la bandeja

Ruta: `GET /api/events` (autenticada por sesión; scope = organización del usuario).
`export const dynamic = 'force-dynamic'`.

Headers de respuesta (obligatorios, exactos):

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

- **Heartbeat**: comentario `: ping\n\n` cada ~25s (mantiene vivo el stream detrás de
  Caddy/Traefik y proxies intermedios).
- **Eventos** (`event: <tipo>`, `data: <json>`, `id: <epoch_ms>`):
  - `message.new` — `{ conversationId, message: {...} }` (nunca de conversaciones `is_test`)
  - `message.status` — `{ conversationId, messageId, status }`
  - `conversation.updated` — `{ conversation: { id } }` **solo el id** (09, RF-09-09):
    "algo cambió en esta conversación (handoff, no leídos, responsable…), refetchea
    con tu vista". Nunca lleva nombre, teléfono, nota de handoff ni responsable: viaja
    a todos los roles. Lo publican el PATCH de la Bandeja, el agente, `/api/bot/*`,
    la ingesta, el pipeline, la asignación y la baja de un miembro (una vez por
    conversación liberada, tras el commit).
  - `conversation.handoff` — `{ conversationId, reason, handoffAt }` (05/02-0): una
    conversación PASÓ a necesitar humano (`handoff_at` de NULL a una fecha; `handoffAt`
    en ISO-8601). Lo publica SOLO `markHandoff` (`src/server/inbox/handoff.ts`), una vez
    por transición, tras el commit y seguido de `conversation.updated { id }`. Nunca para
    conversaciones `is_test`. `reason` es el catálogo de `conversation.handoffReason`
    (`cliente | modelo | error | ventana | hostilidad | manual_reply`); **sí** se publica
    para `manual_reply` (el dueño contestó desde el teléfono) y es el cliente quien
    decide no alertar por ese motivo. Payload mínimo a propósito: nombre, teléfono y
    nota se piden con `GET /api/conversations?ids=<id>`, que aplica la vista del usuario.
    Cliente: `useEvents({ onConversationHandoff })`.
  - `booking.updated` — `{ bookingId }` (015)
  - `lab.run` — `{ runId, status, progress: {done, total}, score? }` (solo Propietario)
- **Visibilidad por conexión** (09, `src/server/events/visibility.ts` →
  `decideDelivery(event, viewer, { canSee })` → `deliver | rewrite | drop`; la ruta
  lo aplica con la cola por conexión `createDeliveryQueue`):
  - Propietario: todo `deliver`.
  - Vendedor: `message.new` / `message.status` / `conversation.handoff` solo si ve la conversación
    (`canSeeConversation`, consulta por PK: suya o sin asignar); `conversation.updated`
    siempre, reescrito a `{ conversation: { id } }`; `booking.updated` sí; `lab.run` no.
  - **Orden**: la ruta procesa los eventos de UNA conexión en orden de llegada (cola de
    promesas por conexión), porque la decisión es asíncrona y un `message.status` no
    debe adelantar a su `message.new`.
  - **Fallo de BD**: si `canSee` lanza, ese evento se descarta (cerrar por defecto) y el
    stream sigue vivo; el cliente se pone al día con el refetch de reconexión o con el
    siguiente `conversation.updated`.
  - El rol se toma al abrir la conexión; la asignación se evalúa por evento (una
    reasignación surte efecto en el siguiente evento, sin reconectar).
- **Catch-up**: el cliente manda `Last-Event-ID` (o el front refetch desde su último
  `last_message_at`) al reconectar; el servidor NO garantiza replay — el cliente hace
  refetch de conversaciones/mensajes con `since=<timestamp>` al evento `open` tras una
  reconexión. EventSource reconecta solo (retry por defecto).
- **Bus interno**: EventEmitter in-process por organización (`server/events`); publicar
  tras commit de BD.
