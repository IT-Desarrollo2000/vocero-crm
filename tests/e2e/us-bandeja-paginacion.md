# Guion E2E — Paginación de la Bandeja (servidor)

> Tarea `dev-tasks/06-paginacion-de-la-bandeja.md` (06-A, «Contrato 06-0»).
> Automatizado en `scripts/e2e-bandeja-paginacion.mjs` (HTTP real, dos cookie
> jars: Propietario + un Vendedor dado de alta por `POST /api/settings/team`):
>
> ```bash
> # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock)
> # y BD migrada (0016 incluida); en local, la BD aislada de .env.e2e
> node --env-file=.env.e2e scripts/e2e-bandeja-paginacion.mjs
> ```
>
> Gasta como mucho 3 POST de inicio de sesión. La BD de E2E no se limpia: los
> recorridos se comparan con los contadores del mismo actor y con el conjunto
> sembrado (nombres con un sufijo aleatorio `S`). La parte de UI (scroll
> infinito, upsert por SSE) es de 06-B.

## a) Preparación

1. El owner entra, conecta WhatsApp (wa-mock) y da de alta a un Vendedor.
   ✅ `GET /api/conversations/counts` responde `ConversationCounts`
   (`all`, `unread`, `human`, `mine`, `unassigned`, `byChannel`,
   `unreadConversations`, `unreadMessages`, `teamMode`).

## b) Siembra

2. Entran 130 mensajes de contactos nuevos (en lotes de 10, `waMessageId`
   únicos); 5 se llaman «José Ñandú …».
   ✅ `counts?q=<S>` llega a 130. Se espera a que la lista se quede quieta
   (el agente puede responder y mover `sortAt`).

## c) Recorrido completo

3. `GET /api/conversations?limit=50`, y después `&cursor=<nextCursor>` hasta
   `nextCursor = null`.
   ✅ Sin ids repetidos, páginas de 50 (la última ≤ 50), orden
   `(sortAt, id)` descendente, total = `counts.all`, las 130 presentes, cada
   fila con `sortAt` y `stageId`. Sin filtros, `unreadConversations` =
   `unread`.

## d) Un mensaje nuevo mientras pagino

4. Tras la página 1 entra un mensaje en una conversación sembrada de la
   página 3; se sigue con el cursor de la página 1.
   ✅ Ninguna conversación duplicada; la única que puede faltar es la que
   subió (por diseño del keyset; la UI la recibe por SSE). Con `limit=1` queda
   al tope.

## e) Filtros y contadores

5. Se marcan 3 como leídas → `filter=unread&q=<S>` recorre exactamente
   `counts.unread`, toda fila con `unreadCount > 0` y sin las leídas.
6. Se pausa la IA en 3 (`PATCH { aiEnabled: false }`) → `filter=human`
   (recorrido con `limit=2`) = `counts.human`, las 3 incluidas.
7. Se mueven 4 leads a otra etapa abierta → `stage=<id>&q=<S>` = esas 4 con
   `stageId`/`stageName` correctos, `counts.all = 4`; etapa inexistente →
   lista vacía (200).
8. `channel=whatsapp&q=<S>` = 130 y `counts.byChannel.whatsapp = 130`;
   `channel=instagram` → 0 (y `byChannel` NO cambia con el canal pedido);
   canal inválido → ignorado.
9. `q=jose nandu <S>` (sin acentos) → las 5 «José Ñandú»; `counts` con
   `q=JOSÉ ÑANDÚ <S>` coincide. Un teléfono tecleado con formato
   (`+52 155-1234 5678`) encuentra su conversación. `q=%` no lista todo.

## f) Vendedor

10. El owner se asigna una conversación y le asigna otra al Vendedor.
    ✅ Para el Vendedor: `?ids=<del owner>,<libre>,cv_no_existe` devuelve
    solo la libre (ausente = no visible) con `nextCursor: null`;
    `GET /api/conversations/<del owner>` → 404 y la suya → 200; su recorrido
    = su `counts.all` = 129 de las sembradas, sin la del owner;
    `teamMode = true`; `filter=mine` = `counts.mine` = 1;
    `assigned=me&filter=unassigned` → vacío (se intersectan);
    `counts?assigned=me` → `all = 1`.

## g) Bordes y compatibilidad

11. `?contact=<contactId>` → esa conversación (1 fila); contacto inexistente
    → vacío. `GET /api/conversations/<inexistente>` → 404.
12. `assigned=todas` → 422 `invalid_query` en la lista y en `/counts`.
13. `cursor=basura` → 200 con la primera página; `limit=0` → 1 fila con
    cursor; `limit=abc` → 50 filas.
14. Sin `limit` → lista completa con `nextCursor: null` (= `counts.all`,
    D-06-1). `since=` (compat) → 200 con `nextCursor: null`.
