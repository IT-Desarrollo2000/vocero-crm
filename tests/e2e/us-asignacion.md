# Guion E2E — Asignación de conversaciones (Propietario / Vendedores)

> Tarea `dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md` (parte a).
> Automatizado en `scripts/e2e-asignacion.mjs` (HTTP real, tres cookie jars y
> lectura del stream SSE real con `fetch` + `AbortController`):
>
> ```bash
> # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock)
> # y BD migrada (0015 incluida); en local, la BD aislada de .env.e2e
> node --env-file=.env.e2e scripts/e2e-asignacion.mjs
> ```
>
> Gasta 3 inicios de sesión (owner, A, B). Los vendedores llevan sufijo
> aleatorio. La parte de handoff necesita `BOT_API_KEY` (si falta, se omite).
> Abre como mucho 2 streams SSE a la vez y siempre los cierra.
>
> **027**: en la Bandeja, "Sin asignar" es el alcance **Buzón** y "Mías" el
> alcance **Mis chats** (el Propietario tiene además **Equipo**: asignadas a
> otro); "Liberar" se llama **Devolver al buzón**. La API conserva
> `?filter=mine` / `?filter=unassigned` / `?unassigned=1` (compat) y suma
> `?assigned=others`. Recorrido de UI: [us-bandeja-alcance.md](us-bandeja-alcance.md).

## a) Preparación

1. El owner entra, conecta WhatsApp (wa-mock) y da de alta a los vendedores
   A y B (`POST /api/settings/team`); ambos inician sesión.
   ✅ `GET /api/settings/team` trae `userId` de cada miembro (es lo que se
   manda al asignar, no el id de membresía).

## b) Una conversación nueva es de todos

2. Llega un mensaje de un contacto nuevo.
   ✅ Sale en la Bandeja de A, de B y del owner con `assignedTo: null`; A la
   ve en `?assigned=unassigned`. `?assigned=otra-cosa` → 422 `invalid_query`.

## c) Dos vendedores la toman a la vez

3. A y B pulsan "Tomar" al mismo tiempo
   (`POST /api/conversations/:id/assign { userId: <yo> }`).
   ✅ Uno recibe 200 y el otro 409 `already_assigned` **sin** decir quién la
   tiene; en BD queda un solo responsable (con su nombre y `assignedAt`).
4. El ganador vuelve a tomarla → 200 (idempotente). El owner intenta tomarla
   para el otro con `expect: "unassigned"` → 409 con `assignedTo`.

## d) El que perdió ya no la ve

5. Con la sesión del perdedor:
   ✅ No está en su lista (ni en el Buzón); `GET`/`POST messages`,
   `POST messages/template`, `PATCH` (marcar leído) y devolverla → 404;
   tomarla → 409; asignársela a otro → 403. El ganador con una plantilla
   inexistente recibe 404 **de plantilla** (pasó la compuerta).
6. Owner: conversación inexistente → 404; asignar a un no-miembro → 422
   `invalid_assignee`; body mal formado → 422 `invalid_body`.

## e) Adjuntos

7. Llega una imagen a la conversación asignada.
   ✅ `GET /api/media/:id` sirve para el responsable y el owner; para el otro
   vendedor → 404.

## f) Tiempo real (SSE)

8. A y B tienen la Bandeja abierta; llega un mensaje a la conversación del
   responsable.
   ✅ El responsable recibe `message.new` con el mensaje completo; el otro
   NO recibe `message.new`/`message.status` de ella, pero sí
   `conversation.updated` reducido a `{ conversation: { id } }`.
9. Llega un mensaje de otro contacto nuevo (sin asignar).
   ✅ Ambos reciben su `message.new`. Ningún vendedor recibe `lab.run`.

## g) Responder = tomar

10. Un vendedor responde la conversación sin asignar.
    ✅ 200 y queda asignada a él sin pasos extra (027: pasa de su Buzón a
    Mis chats); el otro deja de verla.
11. El owner responde una conversación de un vendedor.
    ✅ 200 y NO se la queda (D-09-3).
12. Carrera de envío: A y B mandan texto a la vez a una sin asignar (IA
    apagada en ella).
    ✅ Uno 200 y el otro 404; en el outbox del wa-mock hay UN solo mensaje (el
    del ganador), que queda como responsable.

## h) Reasignar y devolver al buzón

13. El owner reasigna la conversación de un vendedor al otro.
    ✅ El anterior deja de verla (lista, mensajes y su adjunto → 404); el nuevo
    la ve en "Mis chats" (para el owner sigue en "Equipo").
14. El nuevo responsable la devuelve al buzón ("Devolver al buzón",
    `assign { userId: null }`) → 200 con `assignedTo: null`; devolverla otra
    vez → 200 sin cambios; vuelve al Buzón para todos.
15. El owner se asigna una a sí mismo → 200; el vendedor que la tenía la pierde.

## i) Iniciar desde Contactos

16. Un vendedor intenta iniciar conversación (plantilla) con un contacto cuya
    conversación es de otro vendedor.
    ✅ 409 `assigned_to_other`, sin el nombre del otro.

## j) Escalamiento a humano

17. El cerebro externo escala (`POST /api/bot/handoff`) una conversación
    asignada.
    ✅ Conserva su responsable (con `handoffAt`); el otro vendedor sigue sin
    verla.

## k) Baja de un vendedor

18. El owner da de baja a un vendedor con conversaciones asignadas.
    ✅ Todas vuelven al Buzón (sin asignar) y el otro vendedor las ve ahí; el
    owner sigue viendo todo.
