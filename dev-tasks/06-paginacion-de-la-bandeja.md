# 06 — Paginación de la Bandeja

> Estado: en curso (contrato 06-0 fijado; 06-A servidor y 06-B UI en paralelo) · Prioridad: alta · Esfuerzo: L · Migración: sí (`0016`, solo el índice de orden) · Bandera: no (cambio del núcleo, sin superficie opcional)
>
> **Manda la sección [«Contrato 06-0»](#contrato-06-0)** sobre cualquier
> detalle anterior que la contradiga (nombres `handoff` → `human`, badge por
> conversaciones, `since` fuera del cliente, un solo índice).

## 1. Especificación

### Problema / objetivo

Hoy la Bandeja descarga **todas** las conversaciones de la organización en cada
carga y en **cada** evento SSE (mensaje nuevo, cambio de conversación,
reconexión), y filtra, busca y cuenta en el navegador. Además el menú lateral
vuelve a pedir la lista completa solo para sumar el badge de no leídos. Con
cientos o miles de conversaciones esto se vuelve lento en servidor (dos
subconsultas correlacionadas por fila) y en red (cada mensaje entrante =
N filas × cada pestaña abierta × 2 consumidores).

Objetivo: la lista se pide **por páginas** con filtros, búsqueda y contadores
resueltos en el **servidor**, con scroll infinito, y el tiempo real deja de
recargar todo: un evento actualiza o inserta **una** fila. La visibilidad por
rol/asignación (tarea 09) se aplica en la misma consulta.

### Alcance (incluye) / Fuera de alcance

Incluye:
- `GET /api/conversations` con `limit`, `cursor` (keyset), filtros de pastilla
  (`all` | `unread` | `human` | `mine` | `unassigned`), etapa, canal, búsqueda (nombre/teléfono) y,
  la asignación de 09 (`assigned=me|unassigned|all`, RF-09-12).
- Endpoint de contadores (pastillas, canales, total, badge del menú).
- Lectura de conversaciones sueltas por id (lote `?ids=`, para resolver los
  eventos SSE `{ id }`) y por contacto (`?contact=`).
- Scroll infinito en `ConversationList`, upsert en cliente por SSE y, al
  reconectar, recarga de la primera página + contadores (sin `since`,
  RF-06-13).
- Badge del menú lateral servido por el endpoint de contadores
  (`unreadConversations`, D-05-1).
- Índices para que lista y contadores escalen; reemplazo de las subconsultas
  correlacionadas.
- Compatibilidad con los guiones `scripts/e2e-*.mjs` que leen `/api/conversations`.

Fuera de alcance:
- Búsqueda por contenido de mensajes (sigue siendo solo nombre y teléfono, como
  decidió la historia de búsqueda — `helpers.ts:27-29`).
- Paginación del hilo de mensajes (`/api/conversations/:id/messages`).
- La pastilla «Ventana por cerrar» (la agrega la tarea 05 sobre el marco de
  filtros que deja esta tarea).
- Contadores de no leídos POR USUARIO (`unread_count` sigue siendo uno por
  conversación, compartido por el equipo).

### Historias de usuario

- Como **Propietario** quiero que la Bandeja abra rápido aunque tenga miles de
  conversaciones, para no esperar cada vez que entro.
- Como **Vendedor** quiero ver de inmediato solo mis conversaciones y las sin
  asignar, con los mismos filtros y contadores, para trabajar lo mío sin ruido.
- Como **Propietario o Vendedor** quiero que un mensaje nuevo suba esa
  conversación al tope sin que la lista parpadee ni pierda mi posición de
  scroll, para seguir leyendo lo que estaba viendo.
- Como **Propietario o Vendedor** quiero que el enlace «Abrir en Bandeja» desde
  Contactos/Pipeline (`/inbox?contact=…`) abra la conversación aunque sea
  antigua, para no tener que buscarla a mano.
- Como **Propietario o Vendedor** quiero que los números de las pastillas y el
  badge del menú cuenten TODO (no solo lo cargado), para confiar en ellos.

### Requisitos funcionales

- **RF-06-01** `GET /api/conversations?limit=N` devuelve como máximo `N`
  conversaciones (N en [1, 200]; `limit` ilegible → 50; **sin `limit` → lista
  completa con `nextCursor: null`**, D-06-1), ordenadas por
  `coalesce(last_message_at, created_at) DESC, id DESC`, y un `nextCursor`
  opaco construido por el servidor (o `null` si no hay más).
- **RF-06-02** `cursor=<nextCursor>` devuelve la página siguiente sin repetir
  ni saltar filas cuyo orden no cambió entre llamadas (keyset sobre
  `(sort_at, id)`).
- **RF-06-03** Filtros en servidor, combinables:
  `filter=all|unread|human|mine|unassigned` (`human` = `handoff_at is not null
  or ai_enabled = false`, mismo criterio que `needsHuman`; `mine`/`unassigned`
  = mismo predicado que `assigned=me|unassigned`, y si llegan ambos se
  intersectan), `stage=<stageId>` (D-06-2),
  `channel=whatsapp|instagram|messenger`, `q=<texto>` (nombre sin acentos ni
  mayúsculas; teléfono por dígitos con mínimo 3 — `contactSearchSql` de
  `src/server/search.ts`, compartido con Contactos) y
  `assigned=me|unassigned|all` (09, RF-09-12). Todos TOLERANTES (valor
  inválido → default, sin error) **salvo `assigned`, que sigue estricto**
  (422 `invalid_query`, lo exige `scripts/e2e-asignacion.mjs:248`).
- **RF-06-04** Las conversaciones `is_test` jamás aparecen (como hoy,
  `queries.ts:43`).
- **RF-06-05** Visibilidad (cuando exista 09): un Vendedor solo recibe filas
  asignadas a él o sin asignar — en lista, contadores, lectura por id y
  `since`. El Propietario recibe todo. El filtro vive en la consulta, no en el
  cliente.
- **RF-06-06** `GET /api/conversations/counts` (nuevo, `any*`) devuelve
  `ConversationCounts` con los MISMOS `q`/`stage`/`channel`/`assigned` que la
  lista y siempre dentro de lo visible: `all`/`unread`/`human`/`mine`/
  `unassigned` (base + canal), `byChannel` (base, sin canal),
  `unreadConversations` (badge, D-05-1), `unreadMessages` y `teamMode`
  (sin filtros). Capas exactas en el «Contrato 06-0».
- **RF-06-07** `GET /api/conversations?ids=a,b,…` (nuevo, máx. 50 ids; los
  extra se descartan) devuelve los DTO de las conversaciones visibles para el
  usuario entre las pedidas, **aplicando visibilidad pero ignorando cursor y
  filtros**; las ausentes (inexistentes, de prueba o no visibles por rol)
  simplemente no vienen. Invariante para la UI: **id ausente = ya no visible
  para ti** (se retira y, si estaba abierta, se cierra); **presente pero no
  cumple el filtro activo** = sale de la lista pero el hilo abierto se
  conserva. `GET /api/conversations/:id` (nuevo, `any*`) es el atajo de un
  solo id (404 si no visible o `is_test`).
- **RF-06-08** `GET /api/conversations?contact=<contactId>` devuelve la
  conversación real de ese contacto (0 o 1 fila), ignorando cursor y filtros,
  para el enlace profundo.
- **RF-06-09** `since=<ISO>` se conserva en el servidor SOLO por
  compatibilidad (integraciones/guiones): devuelve las conversaciones
  visibles, con los filtros pedidos, con `updated_at > since`, sin cursor
  (tope 500). La UI ya no lo usa (RF-06-13). Las bajas de visibilidad no
  viajan por `since` (D-06-4).
- **RF-06-10** El DTO incluye `sortAt` (ISO en ms de `coalesce(lastMessageAt,
  createdAt)`) para que el cliente reordene tras un upsert, y `stageId`. El
  cliente **nunca** arma un cursor con `sortAt`.
- **RF-06-11** La UI carga la primera página al entrar, pide la siguiente al
  acercarse al final del scroll (IntersectionObserver), muestra «Cargando…» al
  pie y «No hay más conversaciones» al final.
- **RF-06-12** Un `message.new` o `conversation.updated` actualiza o inserta en
  el lugar correcto **solo** esa conversación (sin refetch de la lista
  completa): los ids de eventos que llegan en ráfaga se juntan (~250 ms) en un
  solo `?ids=`; si la conversación deja de cumplir el filtro activo o ya no
  vuelve (no visible), sale de la lista.
- **RF-06-13** Al reconectar el SSE (`onReconnect`), el cliente **no usa
  `since`**: recarga la primera página con los filtros activos + `counts`
  (y deduplica por `id`; la conversación abierta se conserva aunque no
  vuelva en la página, salvo que `?ids=` diga que ya no es visible). Así
  también se entera de las bajas de visibilidad (D-06-4).
- **RF-06-14** El badge del menú (`app-nav.tsx`) usa
  `counts.unreadConversations` (cuenta CONVERSACIONES, D-05-1).
- **RF-06-15** Compatibilidad: la respuesta conserva la clave `conversations`
  (array de `ConversationDto`) y suma `nextCursor`; sin `limit` devuelve la
  lista completa, así los consumidores actuales siguen funcionando (D-06-1).

### Permisos por rol

| Recurso | Propietario: ver | Propietario: editar | Vendedor: ver | Vendedor: editar |
|---|---|---|---|---|
| Lista paginada `GET /api/conversations` | Todas | — | Asignadas a él + sin asignar (09) | — |
| Contadores `GET /api/conversations/counts` | Todas | — | Solo sobre lo visible | — |
| Sueltas `GET /api/conversations?ids=` / `GET /api/conversations/:id` | Sí | — | Solo las visibles (las demás no vienen / 404) | — |
| Marcar leído / IA / reactivar (`PATCH`, existente) | Sí | Sí | Solo si visible | Solo si visible (lo impone 09) |

### Criterios de aceptación

- **CA-06-01** Dado una organización con 120 conversaciones reales y 5 de
  prueba, cuando pido `GET /api/conversations?limit=50`, entonces recibo 50,
  `nextCursor` no nulo, ninguna `is_test`; con el cursor recibo 50 más y luego
  20 con `nextCursor = null`; la unión de las tres páginas son las 120 sin
  duplicados.
- **CA-06-02** Dado el filtro `filter=human&channel=whatsapp&q=jose`, cuando
  pido lista y `counts` (con `channel=whatsapp&q=jose`), entonces cada fila
  cumple los tres criterios, «José» con acento aparece, y `counts.human` =
  número total de filas recorribles con ese filtro.
- **CA-06-03** Dado que estoy en la página 2 con scroll a la mitad, cuando
  entra un mensaje en una conversación de la página 3, entonces esa
  conversación aparece al tope, ninguna otra fila cambia de posición relativa y
  no se dispara un `GET /api/conversations` sin `ids`/`since`/`cursor`.
- **CA-06-04** Dado el filtro «No leídas» activo, cuando abro una conversación
  (markRead), entonces sale de la lista y el contador baja en 1.
- **CA-06-05** Dado `/inbox?contact=<id>` de una conversación que no está en la
  primera página, cuando cargo la Bandeja, entonces queda seleccionada y
  visible al tope de la lista con su hilo abierto.
- **CA-06-06** Dado un Vendedor (con 09), cuando pide `GET
  /api/conversations/<id de una conversación asignada a otro>`, entonces
  recibe 404, y esa conversación no aparece en lista, contadores ni `since`.
- **CA-06-07** Dado que corto la red 30 s y entra un mensaje en ese lapso,
  cuando el SSE reconecta, entonces la conversación aparece actualizada (al
  tope, vía recarga de la primera página + `counts`) sin recargar la página
  del navegador.
- **CA-06-08** Dado el guion `scripts/e2e-selftest.mjs` sin modificar (o con el
  helper de D-06-1), cuando corre contra la app, entonces sigue en verde.
- **CA-06-09** Dado 5 000 conversaciones sembradas, cuando pido la primera
  página y `counts`, entonces cada respuesta tarda < 300 ms en la BD local de
  E2E y el `EXPLAIN` de la lista usa el índice de orden (no Seq Scan + Sort de
  toda la tabla).

### Casos borde y degradación

- **Cursor inválido o manipulado** → se ignora y se responde la primera página
  (tolerante, como `pagination.ts:11-13`), no 422.
- **Conversación que sube al tope mientras pagino**: con keyset, la fila que
  cambia de lugar puede no aparecer en páginas siguientes; no se pierde porque
  llega por SSE y se inserta al tope. Esto es lo opuesto a la razón por la que
  Contactos usa offset (`pagination.ts:6-9`): allí no hay upsert por SSE, aquí
  sí. El cliente deduplica por `id` siempre.
- **`last_message_at` igual en varias filas** → desempate por `id desc`.
- **Etapa borrada o renombrada** → el filtro va por `stageId`, no por nombre;
  un id inexistente devuelve lista vacía, no error.
- **Búsqueda con `%` o `_`** → se escapan (patrón de `contacts/route.ts:57-60`).
- **Evento SSE de una conversación no visible / de prueba** (09 reenvía
  `conversation.updated { id }` a todos, RF-09-09; el Laboratorio hoy publica
  `{ id }` de conversaciones `is_test` desde `applyHandoff`,
  `pipeline.ts:350`) → `?ids=` no la devuelve y el cliente la retira si la
  tenía; si no la tenía, no pasa nada.
- **SSE caído**: la lista sigue usable; los contadores se refrescan al volver
  el foco a la pestaña (`visibilitychange`) además de en `onReconnect`.
- **Error de red al pedir la siguiente página** → el pie muestra «Reintentar»;
  no se vacía lo cargado.
- **Consumidor viejo que pide sin `limit`** → ver D-06-1.

## 2. Plan técnico

### Estado actual

- Ruta: `src/app/api/conversations/route.ts:6-15` — solo lee `since` y llama a
  `listConversations`.
- Consulta: `src/server/inbox/queries.ts:8-52` — sin límite; subconsultas
  correlacionadas por fila: `previewSql` (`:13-19`, último mensaje) y
  `stageSql` (`:20-25`, etapa del lead); filtro `since` sobre `updated_at`
  (`:44`); orden `coalesce(last_message_at, created_at) desc` (`:47`) **sin
  desempate por id**.
- DTO: `serializeConversation` (`queries.ts:101-126`); tipo `ConversationDto`
  (`src/lib/types.ts:5-32`) **no** trae `createdAt` ni clave de orden.
- `windowRemainingMs` se calcula al serializar (`queries.ts:120`,
  `src/server/inbox/window.ts:19-26`) — envejece en el cliente.
- Lectura de una conversación: solo `PATCH` en
  `src/app/api/conversations/[id]/route.ts:16-34`; **no hay GET**. El PATCH
  publica el DTO completo (`:26-30`).
- Filtros en cliente: `filterConversations` (`src/components/inbox/helpers.ts:31-63`),
  contadores en `conversation-list.tsx:98-101`, total del encabezado `:140`,
  pastillas de canal `:141-172`, pastillas `:198-230`, selector de etapa
  `:232-251` cuyas opciones salen de las filas cargadas (`:106-110`).
- Cliente: `inbox-client.tsx:75-81` (`refetchConversations` = lista completa),
  se llama en `onMessageNew` (`:120-149`), `onConversationUpdated`
  (`:150-154`) y `onReconnect` (`:155-160`). `lastFetchRef` se escribe
  (`:68`, `:80`) pero **nunca se usa**: el `since` está muerto en el cliente.
  Enlace profundo `?contact=` busca en lo cargado (`:110-117`).
- Menú: `src/components/app-nav.tsx:96-112` pide la lista completa en cada
  evento solo para sumar `unreadCount`.
- SSE: `conversation.updated` lleva payloads inconsistentes: `{id}` en
  `ingest.ts:375`, `ingest.ts:465`, `pipeline.ts:217`, `pipeline.ts:236`,
  `bot/handoff/route.ts:74-77`, `bot/reset/route.ts:93`; parcial en
  `pipeline.ts:350-355`; `{id}` también en
  `src/app/api/pipeline/leads/[id]/route.ts:156-159`; DTO completo solo en
  `[id]/route.ts:26-30`.
- Índices: `conversation_org_last_idx (organization_id, last_message_at)`
  (`schema.ts:374`) — no sirve al orden por `coalesce(...)`;
  `message_org_conv_idx (organization_id, conversation_id, created_at)`
  (`schema.ts:418-424`) sirve para el preview por conversación;
  `lead_contact_uq` (`schema.ts:227`) garantiza ≤ 1 lead por contacto.
- Búsqueda SQL ya resuelta en Contactos: `translate` + `regexp_replace`
  (`src/app/api/contacts/route.ts:21-22`, `:57-72`).
- Migraciones: drizzle las corre todas en una transacción
  (`scripts/migrate.mjs:149-156`) → `CREATE INDEX CONCURRENTLY` no es posible;
  la última es `drizzle/0012_handoff_nota.sql` (precedente: SQL editado a mano,
  `IF NOT EXISTS`).
- Contrato: `specs/001-vocero-core/contracts/api.md:11`
  (`GET /api/conversations?since=`).

### Cambios de datos

Sin columnas nuevas. Migración oficial **0016** (`drizzle/0016_indices_bandeja.sql`,
ya creada en 06-0): **un solo índice, NO parcial** — ver «Contrato 06-0 →
Índice». Los índices parciales que se proponían aquí (`unread`, `human`,
`updated_at`) quedan **descartados por ahora**: los contadores son agregados
filtrados sobre el mismo recorrido por org, y `since` deja de usarse desde la
UI. Si `EXPLAIN` de 06-A muestra lo contrario, se agregan en una migración
posterior.

- Declararlos también en `src/lib/db/schema.ts` (bloque de índices de
  `conversation`, `:369-375`) para que `pnpm db:generate` no los quiera
  recrear. Drizzle 0.38 acepta `index("…").on(t.organizationId, sql\`…\`)` con
  `.where(sql\`…\`)`; si la generación no reproduce el `DESC` de la expresión,
  se deja el SQL a mano (precedente de 0012) y se verifica que `db:generate` no
  produce diff.
- Cuando 09 agregue `conversation.assigned_user_id`, ese índice
  (`organization_id, assigned_user_id`) es de 09; esta tarea solo lo usa.
- Búsqueda: a escala de miles basta el Seq Scan filtrado por org (como
  Contactos). Un índice trigram (`pg_trgm`) queda como decisión abierta
  (D-06-5) porque exige la extensión.
- Opcional, NO en esta tarea: borrar `conversation_org_last_idx` cuando nadie
  lo use (verificar con `pg_stat_user_indexes` en prod antes).

### Servidor

1. **`src/server/inbox/list-query.ts` (nuevo)** — tipos y parseo:
   - `InboxQuery = { limit, cursor?, filter, stageId?, channel?, q?, assigned? }`
     parseado con Zod desde `URLSearchParams` (tolerante: valor inválido →
     default).
   - `encodeCursor({ sortAt, id })` / `decodeCursor(str)` → base64url de
     `{"t":"<ISO>","i":"<id>"}`; inválido → `null`.
   - `inboxWhere(organizationId, viewer, query)` → `SQL` con `scoped(...)`
     (`src/lib/db/tenant.ts`), `is_test = false`, filtros, búsqueda, el filtro
     `assigned` y el predicado de visibilidad de 09
     `conversationVisibleTo(viewer)` (`src/server/inbox/visibility.ts`,
     **nuevo, tarea 09**; `Viewer = { userId, role }` con `Role` de
     `src/lib/roles.ts`, **nuevo, tarea 00**). Mientras 09 no exista, el
     predicado es `undefined`.
2. **`src/lib/search-sql.ts` (nuevo)** — extraer `UNACCENT_FROM/TO` y el
   `or(translate…, regexp_replace…)` de `contacts/route.ts:21-22,57-72` a
   `searchContactSql(q)`; Contactos y Bandeja lo comparten (sin cambio de
   comportamiento en Contactos).
3. **`listConversations` en `src/server/inbox/queries.ts:8-52`** → firma
   heredada de 09 (`listConversations(organizationId, viewer, opts)`)
   ampliada: `opts` pasa a ser `InboxQuery` y devuelve
   `{ rows: ConversationDto[]; nextCursor }`. Mantiene el `leftJoin(user)` que
   09 agrega para `assignedTo.name`:
   - Keyset: `where (sort_at, id) < (cursor.t, cursor.i)` con
     `sort_at = coalesce(last_message_at, created_at)` — expresión idéntica a la
     del índice; `order by sort_at desc, id desc limit limit+1` (la fila extra
     decide `nextCursor`).
   - **Etapa por JOIN**, no subconsulta: `left join lead l on l.contact_id =
     contact.id left join pipeline_stage s on s.id = l.stage_id` (seguro por
     `lead_contact_uq`). Devuelve `stageId` y `stageName`.
   - **Preview en lote**: tras obtener la página, una consulta
     `select distinct on (conversation_id) conversation_id, coalesce(text, type)
     from message where organization_id = $1 and conversation_id = any($ids)
     order by conversation_id, created_at desc` (usa `message_org_conv_idx`).
     Alternativa equivalente: `left join lateral (... limit 1)` en SQL crudo.
     Se elige el lote para no pelear con el ORM.
   - Variantes: `getConversationsByIds(organizationId, viewer, ids)` (lote,
     máx. 50, con visibilidad) y `getConversationByContact(organizationId,
     viewer, contactId)`. Mismo `select`/serialización, sin keyset.
   - `since`: misma `where` + `updated_at > since`, sin cursor, tope 500.
4. **`countConversations(organizationId, viewer, query)` (nuevo, en `queries.ts`)** — una
   sola consulta con agregados filtrados:
   ```sql
   select
     count(*) filter (where <canal_ok>)                                   as all,
     count(*) filter (where <canal_ok> and unread_count > 0)              as unread,
     count(*) filter (where <canal_ok> and (handoff_at is not null
                                           or ai_enabled = false))        as human,
     count(*) filter (where <canal_ok> and assigned_user_id = $yo)        as mine,
     count(*) filter (where <canal_ok> and assigned_user_id is null)      as unassigned,
     count(*) filter (where channel = 'whatsapp')                         as wa,
     count(*) filter (where channel = 'instagram')                        as ig,
     count(*) filter (where channel = 'messenger')                        as fb
   from conversation c join contact ct on ct.id = c.contact_id
   left join lead l on l.contact_id = ct.id
   where <org, is_test=false, visibilidad, assigned, q, stage>
   ```
   y, sobre `<org, is_test=false, visibilidad>` (sin `q`/`stage`/canal/
   `assigned`): `unreadConversations = count(*) filter (where unread_count >
   0)`, `unreadMessages = sum(unread_count)` y `teamMode` (ver «Contrato
   06-0 → Contadores»). Consultas en `Promise.all`.
5. **Rutas**:
   - `src/app/api/conversations/route.ts` — leer `limit`, `cursor`, `filter`,
     `stage`, `channel`, `q`, `assigned`, `ids`, `contact`, `since`; armar el
     `viewer` desde la sesión (`{ userId, role }`); responder
     `{ conversations, nextCursor }`. Precedencia: `ids` > `contact` > `since`
     > lista paginada. Compatibilidad según D-06-1.
   - `src/app/api/conversations/counts/route.ts` **(nuevo; stub 501 desde
     06-0)** — `ConversationCounts`: `{ all, unread, human, mine, unassigned,
     byChannel: { whatsapp, instagram, messenger }, unreadConversations,
     unreadMessages, teamMode }`.
   - `src/app/api/conversations/[id]/route.ts` — agregar `GET` de un id
     (RF-06-07), junto al `PATCH` existente (`:16-34`).
6. **DTO**: `ConversationDto` (`types.ts:5-32`) + `sortAt: string` y
   `stageId: string | null`; `serializeConversation` (`queries.ts:101-126`) los
   llena (recibe `stageId`). No se rompe a nadie: campos aditivos.
7. **Payloads SSE: sin cambios aquí.** 09 deja `conversation.updated` como
   `{ conversation: { id } }` para todos (RF-09-09, T-09-08, reduciendo en
   origen `[id]/route.ts:27` y `pipeline.ts:350-355`) y filtra `message.new`
   por visibilidad. Esta tarea se apoya en eso: el cliente resuelve cada id con
   `?ids=` (que aplica visibilidad), así ningún dato viaja por el bus
   org-wide. Publicadores de `conversation.updated` que quedan con `{ id }`:
   `ingest.ts:375`, `ingest.ts:465`, `pipeline.ts:217`, `pipeline.ts:236`,
   `pipeline.ts:350`, `bot/handoff/route.ts:74-77`, `bot/reset/route.ts:93-96`,
   `src/app/api/pipeline/leads/[id]/route.ts:156-159`, `[id]/route.ts:27`.
   Recomendado de paso: no publicar para `is_test` (el contrato `sse.md` lo
   promete y `applyHandoff` del Laboratorio lo incumple, `pipeline.ts:350`);
   lo resuelve el helper `markHandoff` de 05.
8. **Contrato**: actualizar `specs/001-vocero-core/contracts/api.md:11`
   (parámetros nuevos, `nextCursor`, `/counts`, `GET /:id`).

### UI

- **`src/components/inbox/use-inbox-list.ts` (nuevo)** — hook que concentra el
  estado de la lista: `items` (Map por id + orden), `nextCursor`, `loading`,
  `error`, `counts`; acciones `loadFirst(filters)`, `loadMore()`,
  `upsert(dto)`, `remove(id)`, `resolveIds(ids)` (junta ids ~250 ms → un
  `GET ?ids=`; los que no vuelven se retiran), `refreshCounts()`
  (debounce ~500 ms). `upsert` decide con un **predicado cliente** `matchesFilters(dto,
  filters)` — se reutiliza `filterConversations`/`needsHuman` de `helpers.ts`
  (queda como espejo del filtro SQL; un test unitario compara ambos sobre el
  mismo fixture) — y reordena por `sortAt`, `id`. El espejo crece con cada
  filtro de servidor: 09 le suma `assigned` (`assignedTo?.userId ===
  viewer.userId` con `useViewer()` de 00, o `assignedTo === null`) y 05 la
  ventana (`lastInboundAt` entre ahora − 24 h y ahora − 22 h). El cursor es
  opaco: el hook solo reenvía el `nextCursor` recibido. `teamMode` sale de
  `counts.teamMode`.
- **`inbox-client.tsx`**:
  - `refetchConversations` (`:75-81`) → `loadFirst`.
  - `onMessageNew` (`:120-149`): conserva lo del hilo (`:121-133`) y cambia
    `refetchConversations()` (`:134`) por `resolveIds([conversationId])` +
    `refreshCounts()`. Nunca lista completa.
  - `onConversationUpdated` (`:150-154`): `resolveIds([conversation.id])` +
    `refreshCounts()`.
  - `onReconnect` (`:155-160`) y `visibilitychange`: `loadFirst` (primera
    página con los filtros activos) + `refreshCounts()`. Sin `since`
    (RF-06-13); `lastFetchRef` se elimina.
  - `?contact=` (`:110-117`): si no está en `items`, `GET
    /api/conversations?contact=<id>` → `upsert` (forzado aunque no cumpla el
    filtro) → `select`.
  - `selected` (`:163`) se busca en `items`; si la seleccionada sale por
    filtro, el hilo sigue abierto (se conserva una copia del DTO seleccionado).
- **`conversation-list.tsx`**:
  - Los filtros (`:71-74`) suben al hook (son parámetros de servidor). La
    búsqueda conserva el input NO controlado (`:77-87`) y dispara `loadFirst`
    con debounce 300 ms.
  - Contadores (`:98-101`, `:140`, `:167`, `:201-207`) salen de `counts`.
  - Selector de etapa (`:232-251`): opciones desde `useStages()` (ya importado
    en `:114`), valor = `stageId`. Se elimina la derivación `:106-110` y el
    efecto de recarga por nombres desconocidos (`:118-127`) deja de ser
    necesario para el filtro (se mantiene para el color del punto).
  - Scroll infinito: centinela al final de `<ul>` (`:266-359`) con
    `IntersectionObserver` (`rootMargin: 400px`) → `loadMore()`; pie con
    «Cargando…», «Reintentar» o «No hay más conversaciones».
  - Estado vacío (`:257-258`): «Sin conversaciones todavía» solo si
    `counts.all === 0` sin filtros; con filtros, «Sin resultados».
- **`app-nav.tsx:96-112`**: `refetchUnread` → `GET /api/conversations/counts`
  (`unreadConversations`, D-05-1), con debounce y también al
  `visibilitychange`.

### Tareas ordenadas

- [x] **T-06-01** (06-0) Migración 0016, un índice (SQL a mano, `IF NOT EXISTS`) +
  declaración en `schema.ts`; verificar `pnpm db:generate` sin diff y `EXPLAIN`
  de la consulta de lista. *(sin dependencias)*
- [x] **T-06-02** (06-0, como `contactSearchSql` en `src/server/search.ts`) Extraer `searchContactSql` a `src/lib/search-sql.ts` y usarlo
  en `contacts/route.ts` (refactor sin cambio de comportamiento; corre
  `scripts/e2e-contactos-paginacion.mjs`). *(—)*
- [x] **T-06-03** (06-0) `list-query.ts`: parseo Zod de filtros + `encode/decodeCursor`
  + unit tests. *(—)*
- [x] **T-06-04** (06-0; `stageId` lo llena 06-A) DTO: `sortAt` y `stageId` en `types.ts` y
  `serializeConversation`. *(—)*
- [x] **T-06-05** Reescribir `listConversations` (keyset, join de etapa,
  preview en lote, filtros, `since`, `contact`, `ids`) usando
  `conversationVisibleTo(viewer)` de 09 (o `undefined` si 09 aún no está). *(T-06-01..04)*
- [x] **T-06-06** `countConversations` + `GET /api/conversations/counts`. *(T-06-03, T-06-05)*
- [x] **T-06-07** `?ids=` en lote + `GET /api/conversations/:id`, ambos con visibilidad. *(T-06-05)*
- [x] **T-06-08** Ruta `GET /api/conversations` con los nuevos parámetros y
  compatibilidad (D-06-1). *(T-06-05)*
- [ ] **T-06-09** Verificar con 09 que todos los `conversation.updated` viajan
  como `{ id }` (paso 7) y que el filtro SSE de `message.new` está activo; si
  06 va antes que 09, el cliente igual usa `?ids=` (funciona con cualquier
  payload). *(09)*
- [ ] **T-06-10** Hook `use-inbox-list.ts` (upsert/remove/orden/recarga al reconectar/counts). *(T-06-06..09)*
- [ ] **T-06-11** `conversation-list.tsx`: filtros a servidor, contadores de
  `counts`, etapas de `useStages`, scroll infinito. *(T-06-10)*
- [ ] **T-06-12** `inbox-client.tsx`: SSE con upsert, `loadFirst` al reconectar (sin `since`),
  `?contact=` fuera de página. *(T-06-10)*
- [ ] **T-06-13** `app-nav.tsx`: badge desde `counts`. *(T-06-06)*
- [x] **T-06-14** Actualizar el contrato `api.md` y adaptar los guiones
  según D-06-1. *(T-06-08)* — 06-A: `api.md` al día; con D-06-1 = (a) los
  guiones existentes no cambian.
- [ ] **T-06-15** Pruebas (abajo) + gate `pnpm typecheck && pnpm lint && pnpm
  build && pnpm test` + E2E en BD aislada (`.env.e2e`, Postgres :5433). *(todo)*

### Pruebas

Unit (`tests/unit/`):
- `inbox-cursor.test.ts` (nuevo): encode/decode ida y vuelta; cursor basura →
  `null`; orden estable con `sortAt` iguales (desempate por id).
- `inbox-query.test.ts` (nuevo): parseo tolerante de `limit` (0, 9999, "abc"),
  `filter` desconocido → `all`, `channel` inválido → ignorado, `q` con `%`.
- `inbox-filters.test.ts` (existente): extender con `matchesFilters` del hook y
  un caso de paridad cliente/servidor (mismo fixture que el E2E), incluyendo
  `assigned` (09) y `closing` (05) cuando esas tareas lleguen.
- `inbox-upsert.test.ts` (nuevo): `upsert` reordena por `sortAt`, no duplica,
  saca la fila que deja de cumplir el filtro, conserva la seleccionada.
- `inbox-resolve-ids.test.ts` (nuevo): `resolveIds` junta una ráfaga de ids
  en una sola petición y retira los que no vuelven (no visibles / `is_test`).

E2E (app viva con `WA_MOCK_ENABLED=true`, wa-mock + ai-mock, BD aislada):
- **`scripts/e2e-bandeja-paginacion.mjs` (nuevo)** + guion
  **`tests/e2e/us-bandeja-paginacion.md` (nuevo)**:
  1. Siembra 120 conversaciones vía `POST /api/dev/wa-mock/inbound` (nombres y
     teléfonos con sufijo aleatorio, como `e2e-search-filters.mjs:45-58`).
  2. API: recorre páginas con `limit=50` → 120 únicas, ninguna `is_test`
     (crea antes una corrida del Laboratorio para tener `is_test`).
  3. API: `filter=unread`, `filter=human` (provoca handoff con
     `/api/bot/handoff`), `q` con acento y con teléfono formateado, `stage`,
     `channel`; compara `counts` con el largo recorrido.
  4. UI (Playwright, `waitUntil: "load"`): scroll hasta el final → aparece
     «No hay más conversaciones»; nunca hay `id` repetido en el DOM.
  5. UI: con scroll en página 2, inyecta un entrante en una conversación de
     página 3 → sube al tope; intercepta `page.on("request")` y verifica que
     no hubo `GET /api/conversations` sin `ids`/`since`/`cursor`/`contact`.
  6. UI: `/inbox?contact=<id viejo>` → seleccionada.
  7. Camino infeliz: `cursor=basura` → 200 primera página; `limit=0` → 1 fila;
     `page.route` que falla la página 2 → pie «Reintentar» y la lista conserva
     lo cargado; SSE cortado (`context.setOffline(true)` 5 s) + entrante →
     tras reconectar aparece sin recarga.
  8. Con 09: segunda cuenta Vendedor → no ve la conversación asignada a otro
     (lista, counts, `?ids=` la omite, GET por id = 404); al reasignarle una
     conversación (`conversation.updated { id }`) aparece sin recargar.
- **Extender** `scripts/e2e-search-filters.mjs` (filtros ahora son de
  servidor: mismas aserciones de UI deben seguir pasando) y
  `scripts/e2e-selftest.mjs` (agregar el nuevo guion al arnés `pnpm test:e2e`).
- Guiones que leen `/api/conversations` (deben seguir verdes, ver D-06-1):
  `e2e-selftest.mjs` (≈20 llamadas, p. ej. `:117`, `:177`, `:521`, `:660`,
  `:1105`, `:2031`), `e2e-bitacora-etapas.mjs:201`,
  `e2e-envio-instantaneo.mjs:72`, `e2e-ficha-lead.mjs:89`,
  `e2e-handoff-nota.mjs:70,139`, `e2e-responsive.mjs:99`,
  `e2e-search-filters.mjs:60,156`, `e2e-send-failure.mjs:58`,
  `e2e-templates-multivar.mjs:163`.

### Riesgos y decisiones abiertas

> **Decididas (2026-10-12):** D-06-1 = (a) lista completa sin `limit`;
> D-06-2 = `stageId`; D-06-4 = recarga de la primera página en `onReconnect`
> (sin `since` en el cliente). D-06-5 = no ahora.

- **D-06-1 (compatibilidad, decide el dueño)** — Sin `limit` en la URL:
  - (a) *Recomendada*: comportamiento legado (lista completa sin cursor,
    `nextCursor: null`), marcado como deprecado en `api.md`; la UI siempre
    manda `limit`. Cero cambios en ~25 llamadas de guiones; el riesgo de
    rendimiento queda solo para clientes viejos.
  - (b) Default 50 + helper `allConversations(api)` en los guiones que
    recorre cursores. Más limpio, pero toca `e2e-selftest.mjs` (2 198 líneas,
    que no limpia su BD: un `.find()` sobre 50 filas fallaría en silencio).
- **D-06-2** Filtro de etapa por `stageId` (recomendado, resistente a
  renombres) en vez de por nombre (hoy `helpers.ts:50`). Cambia la URL interna
  de la UI; no hay consumidores externos.
- **D-06-3** Costo de resolver eventos: con `conversation.updated { id }`
  (decisión de 09) cada evento cuesta un `GET ?ids=` por pestaña abierta. Se
  acota juntando ráfagas (~250 ms) y con el `EventSource` único por pestaña
  que propone 05. Alternativa descartada: DTO completo en el bus (fuga de datos
  a Vendedores, contradice RF-09-09).
- **D-06-4** `since` con bajas: hoy `since` solo devuelve filas actualizadas;
  una conversación que DEJÓ de ser visible (reasignada en 09) no se entera. ¿Se
  agrega `removedIds` (requiere registro de reasignaciones de 09) o basta con
  `loadFirst` en `onReconnect`? Recomendado: `loadFirst` en reconexión y upsert
  por evento en vivo.
- **D-06-5** `pg_trgm` para la búsqueda: solo si una instancia supera ~50 000
  conversaciones. En Supabase existe en `extensions` (`search_path` de
  `migrate.mjs:152`); en Postgres propio exige `CREATE EXTENSION` con
  privilegios. Propuesta: no ahora.
- **Riesgo**: la migración corre en transacción al arrancar el contenedor
  (`migrate.mjs`); `CREATE INDEX` sin `CONCURRENTLY` bloquea escrituras de
  `conversation` mientras se construye. Con miles de filas son segundos; avisar
  en el deploy.
- **Riesgo**: dos `EventSource` por página (menú + Bandeja, `use-events.ts:37`)
  — no empeora con esta tarea; la 05 propone unificarlo.
- **Riesgo**: `windowRemainingMs` viaja calculado y envejece; el cliente debe
  recalcularlo desde `lastInboundAt` (lo usa 05).

## Contrato 06-0

Fijado en el paso 06-0 para que **06-A (servidor)** y **06-B (UI)** trabajen
en paralelo. Manda sobre el resto del documento. Código ya en el repo:
`src/lib/types.ts` (`InboxFilter`, `ConversationsPage`, `ConversationCounts`,
`ConversationDto.sortAt/stageId`), `src/server/inbox/list-query.ts` (parseo,
cursor, SQL de orden), `src/server/search.ts` (`contactSearchSql`), la firma
de `listConversations`, los stubs 501 de `/counts` y `GET /[id]`,
`ROUTE_POLICY` y la migración 0016. Pruebas: `tests/unit/inbox-query.test.ts`.

### Endpoints

| Endpoint | Política | Respuesta | Estado en 06-0 |
|---|---|---|---|
| `GET /api/conversations` | `any*` | `ConversationsPage = { conversations: ConversationDto[]; nextCursor: string \| null }` | Implementado (06-A): todos los modos y filtros |
| `GET /api/conversations/counts` | `any*` | `ConversationCounts` | Implementado (06-A) |
| `GET /api/conversations/[id]` | `any*` | `{ conversation: ConversationDto }`; 404 `not_found` si no existe, es `is_test` o no la ves | Implementado (06-A) |

Las tres van con `withAuth(...)` y la visibilidad de 09
(`conversationVisibleTo(viewer)`) en el WHERE; `is_test = false` siempre.

### Parámetros de `GET /api/conversations`

| Parámetro | Valores | Inválido → |
|---|---|---|
| `assigned` | `me` \| `unassigned` \| `all` (default `all`) | **422 `invalid_query`** (estricto; `scripts/e2e-asignacion.mjs:248`) |
| `limit` | entero; ausente/vacío = **lista completa** (D-06-1); presente → clamp [1, 200] | ilegible → 50 |
| `cursor` | opaco, el `nextCursor` de la página anterior | ignorado → primera página |
| `filter` | `all` \| `unread` \| `human` \| `mine` \| `unassigned` | `all` |
| `stage` | `stageId` (D-06-2); id inexistente = lista vacía | (texto > 64 → ignorado) |
| `channel` | `whatsapp` \| `instagram` \| `messenger` | ignorado (todos) |
| `q` | texto (≤ 200) — `contactSearchSql(q)` sobre `contact` | vacío → sin filtro |
| `ids` | `a,b,c` — dedup, máx. **50** (los extra se descartan) | vacío → no es modo lote |
| `contact` | `contactId` (deep link) | — |
| `since` | ISO — **solo compatibilidad**, la UI no lo usa | fecha ilegible → ignorado |

Parseo: `parseInboxQuery(searchParams)` (todo menos `assigned`, que valida
la ruta). **Precedencia de modos**: `ids` > `contact` > `since` > lista
(paginada si hay `limit`). En los modos `ids`/`contact`/`since`,
`nextCursor` = `null`.

Semántica de filtros (06-A en SQL; 06-B como espejo cliente para el upsert):

- `unread` = `unread_count > 0`.
- `human` = `handoff_at IS NOT NULL OR ai_enabled = false` (regla `needsHuman`
  de `src/components/inbox/helpers.ts`).
- `mine` = `assigned_user_id = viewer.userId`; `unassigned` =
  `assigned_user_id IS NULL` — idénticos a `assigned=me|unassigned`; si llegan
  `filter` y `assigned` a la vez, se **intersectan** (AND).
- `stage` por `lead.stage_id` (JOIN `lead` por `contact_id`, seguro por
  `lead_contact_uq`).

### Modos sueltos

- **`?ids=a,b,c`**: aplica **visibilidad** (y `is_test = false`) pero
  **ignora** cursor, `limit` y filtros. Invariante para la UI:
  - id **ausente** en la respuesta = ya no es visible para ti (no existe, es
    de prueba o se reasignó) → se retira de la lista y, si estaba abierta, se
    cierra el hilo;
  - id **presente** pero que no cumple el filtro activo → sale de la lista,
    pero si es la conversación abierta, el hilo se conserva.
- **`?contact=<contactId>`**: la conversación real (no `is_test`) visible de
  ese contacto, 0 o 1 fila, ignorando filtros — para `/inbox?contact=`.
- **`GET /api/conversations/[id]`**: el atajo de un id, con visibilidad;
  404 si no.

### Orden, cursor y keyset (fórmula exacta)

- `sort_at := coalesce(conversation.last_message_at, conversation.created_at)`
  (`sortAtSql`). Columnas `timestamp` sin zona, precisión de µs.
- `ORDER BY sort_at DESC, conversation.id DESC` (`inboxOrderBy`) — mismo
  texto que el índice (sin `NULLS LAST`).
- El servidor selecciona además
  `to_char(sort_at, 'YYYY-MM-DD HH24:MI:SS.US')` (`sortKeySql`), pide
  `limit + 1` filas y, si sobra la extra, arma el cursor desde la **última fila
  devuelta** (no la extra):
  `nextCursor = base64url(JSON.stringify({ t: <sortKey>, i: <id> }))`
  (`encodeCursor`).
- `decodeCursor` exige `t` con 6 decimales (`YYYY-MM-DD HH:MM:SS.ffffff`) e
  `i` de 1..64 caracteres; otra cosa → `null` → primera página.
- Página siguiente: `(sort_at, conversation.id) < ($t::timestamp, $i)`
  (`keysetCondition`, comparación fila-valor). 06-A confirma con `EXPLAIN`
  que entra como Index Cond junto a `organization_id = $org`; si no, usa la
  forma expandida equivalente `sort_at < $t OR (sort_at = $t AND id < $i)`.
- El cliente **nunca** deriva un cursor: `ConversationDto.sortAt` (ISO en ms)
  es solo para reordenar tras un upsert. Un `Date` de JS pierde los µs y el
  keyset repetiría o saltaría filas.

### Contadores (`ConversationCounts`)

```ts
{ all, unread, human, mine, unassigned,
  byChannel: { whatsapp, instagram, messenger },
  unreadConversations, unreadMessages, teamMode }
```

Acepta los mismos `q`, `stage`, `channel`, `assigned` que la lista (mismo
parseo; `assigned` inválido → 422). Ignora `filter`, `limit`, `cursor`. Capas:

- **base** = org ∧ `is_test = false` ∧ visibilidad ∧ `q` ∧ `stage` ∧ `assigned`;
- `all` / `unread` / `human` / `mine` / `unassigned` = base ∧ `channel` ∧
  predicado de la pastilla (así el número de cada pastilla = filas recorribles
  con ese `filter`);
- `byChannel[ch]` = base ∧ `channel = ch` (ignora el `channel` pedido);
- `unreadConversations` = count(`unread_count > 0`) y `unreadMessages` =
  sum(`unread_count`), ambos **solo con visibilidad** (sin `q`/`stage`/
  `channel`/`assigned`). El badge del menú y de la pestaña usa
  **`unreadConversations`** (D-05-1).
- `teamMode` = `!isOwner(viewer) || count(member de la org) > 1 || EXISTS
  (conversación visible, no de prueba, con assigned_user_id NOT NULL)` — sin
  filtros. Es la regla de `inbox-client.tsx` (~432-435) pero ESTABLE: no
  depende de las páginas cargadas. 06-B la toma de `counts` en vez de
  calcularla.

### Firma de servidor

```ts
listConversations(organizationId, viewer, opts?: {
  since?, assigned?, limit?, cursor?, filter?, stageId?, channel?, q?, ids?, contactId?
}) → Promise<{ conversations: ConversationDto[]; nextCursor: string | null }>
```

(`ListConversationsOptions = Partial<InboxQuery> & { assigned? }`). 06-A
agrega `countConversations(organizationId, viewer, query)` →
`ConversationCounts`. Búsqueda: `contactSearchSql(q)` de
`src/server/search.ts` (extraída de Contactos sin cambio de comportamiento).

### Índice (migración 0016)

```sql
CREATE INDEX IF NOT EXISTS "conversation_org_sort_idx" ON "conversation"
  USING btree ("organization_id",(coalesce("last_message_at", "created_at")) DESC,"id" DESC);
```

**No parcial**, por elección: la consulta manda `is_test = false` como
parámetro (`eq(c.isTest, false)` → `$n`) y con sentencias preparadas el plan
genérico no puede probar el predicado de un índice parcial, así que lo dejaría
de usar en silencio. Las conversaciones `is_test` se descartan como filtro
sobre el recorrido (son minoría). Si 06-A ve en `EXPLAIN` que pesan, la
alternativa es un índice parcial **con** `sql\`is_test = false\`` inline en
la consulta (nunca parámetro). Sin `CONCURRENTLY` (migrate.mjs corre en
transacción). Declarado en `schema.ts` con las expresiones como SQL crudo;
`pnpm db:generate` no produce diff.

### Verificación del plan (06-A)

La consulta de lista queda en la forma que prefiere el contrato: keyset
fila-valor `(coalesce(last_message_at, created_at), id) < ($t::timestamp, $i)`
dentro de `organization_id = $org AND is_test = $false AND <visibilidad>`,
`ORDER BY coalesce(...) DESC, id DESC LIMIT limit+1`, con los JOIN de
`contact`, `lead`, `pipeline_stage` y `user`; el preview va aparte en UN
`SELECT DISTINCT ON (conversation_id) … WHERE organization_id = $1 AND
conversation_id IN (…) ORDER BY conversation_id, created_at DESC, id DESC`.
Los unit (`tests/unit/inbox-list.test.ts`) fijan ese texto.

Para confirmar el plan contra la BD aislada (`.env.e2e`, Postgres :5433) con
datos sembrados (p. ej. tras `scripts/e2e-bandeja-paginacion.mjs`, o 5 000
filas para CA-06-09), imitar las sentencias PREPARADAS de postgres-js (plan
genérico con parámetros), no un SQL con literales:

```sql
SET search_path = vocero, extensions;  -- o el esquema de la instancia
PREPARE lista(text, boolean, text, text, int) AS
  SELECT c.id, to_char(coalesce(c.last_message_at, c.created_at), 'YYYY-MM-DD HH24:MI:SS.US')
  FROM conversation c
  JOIN contact ct ON c.contact_id = ct.id
  LEFT JOIN lead l ON l.contact_id = ct.id
  LEFT JOIN pipeline_stage s ON s.id = l.stage_id
  LEFT JOIN "user" u ON u.id = c.assigned_user_id
  WHERE c.organization_id = $1 AND c.is_test = $2 AND true
    AND (coalesce(c.last_message_at, c.created_at), c.id) < ($3::timestamp, $4)
  ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
  LIMIT $5;
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE lista('<org>', false, '<t del cursor>', '<id del cursor>', 51);
```

Esperado: `Index Scan using conversation_org_sort_idx` con
`Index Cond: (organization_id = $1) AND (ROW(...) < ROW($3, $4))` y sin `Sort`
de toda la tabla; los JOIN como Nested Loop sobre las ≤ 51 filas. Si la
comparación fila-valor NO entra como Index Cond (queda como Filter), se cambia
`keysetCondition` a la forma expandida
`sort_at < $t OR (sort_at = $t AND id < $i)` y se repite. Lo mismo para
`/counts` (una pasada `count(*) FILTER (WHERE …)` sobre las filas de la org;
objetivo < 300 ms a 5 000 filas) y para el preview
(`Index Scan using message_org_conv_idx`).

### SSE y reconexión (06-B)

- `message.new` / `conversation.updated { id }` → juntar ids (~250 ms) →
  `GET ?ids=` → upsert/retiro según la invariante de arriba + `counts`
  (debounce).
- `onReconnect` y `visibilitychange` → **recargar la primera página** con los
  filtros activos + `counts`. **Sin `since`** en el cliente.

## 3. Dependencias con otras tareas

- **00 — Roles y permisos** (antes): `Role`/`ROLE` de `src/lib/roles.ts` y
  `SessionContext.role: Role` (**nuevos, tarea 00**), base del `viewer`.
- **09 — Asignación** (antes): `conversation.assigned_user_id`, el helper de
  visibilidad `conversationVisibleTo(viewer)` / `canSeeConversation`
  (`src/server/inbox/visibility.ts`, **nuevo, tarea 09**), el parámetro
  `assigned=me|unassigned|all` (RF-09-12), el filtro SSE y los payloads
  `{ id }` (RF-09-09). Si 06 se implementa antes por urgencia, deja el
  predicado como `undefined` y 09 lo enchufa en `inboxWhere` sin tocar el
  resto.
- **05 — Alertas** (después): usa `counts.unreadConversations` para título/favicon (D-05-1),
  `?ids=` para resolver eventos y el marco de filtros para la pastilla
  «Ventana por cerrar».
- **02 — Métricas**: independiente; comparte la migración de índices solo si
  coinciden en el tiempo (coordinar número de migración).
