# 09 — Equipo: asignación de conversaciones y respuestas rápidas

> Estado: propuesto · Prioridad: alta · Esfuerzo: L (a: M · b: S-M) · Migración: sí (`00NN_asignacion_respuestas_rapidas.sql`, siguiente libre tras la de 00 — tentativamente `0014`) · Bandera: no (núcleo; la asignación no cambia nada para una instancia con un solo usuario)

## 1. Especificación

### Problema / objetivo

Con varios vendedores en la misma Bandeja no hay forma de saber quién atiende
a quién: dos personas contestan al mismo cliente, o nadie lo hace porque cada
uno cree que lo tomó otro. Además todos ven todas las conversaciones, y el
dueño decidió que un Vendedor solo vea **las suyas + las sin asignar** (para
tomarlas). Por otro lado, los vendedores reescriben a mano las mismas
respuestas (horarios, ubicación, formas de pago) con ortografía y tono
distintos.

Objetivo:
- **(a) Asignación**: cada conversación tiene a lo sumo un responsable
  (`assigned_user_id`). El Vendedor ve solo las suyas y las sin asignar; puede
  tomar y liberar. El Propietario ve todo y asigna/reasigna. La regla vive **en
  el servidor** (query, endpoints, SSE), no en el cliente.
- **(b) Respuestas rápidas**: catálogo de textos de la organización, gestionado
  por el Propietario en Ajustes y usado por todos desde el compositor con el
  atajo `/`, con variables simples (`{{nombre}}`…), respetando la ventana de
  24 h (fuera de ventana solo plantillas, como hoy).

### Alcance (incluye) / Fuera de alcance

**Incluye**
- Columna `conversation.assigned_user_id` (nullable, FK a `user`,
  `ON DELETE SET NULL`) + `assigned_at`.
- Tomar / liberar (Vendedor), asignar / reasignar / liberar (Propietario), y
  "responder = tomar" implícito para el Vendedor.
- Visibilidad del Vendedor aplicada en: lista, detalle (PATCH), mensajes (GET),
  envío (texto, adjunto, ubicación/contacto, plantilla), adjuntos
  (`/api/media`), SSE (`/api/events`) e inicio de conversación desde Contactos.
- Pastillas "Mías" y "Sin asignar" en la Bandeja + responsable visible en la
  fila y en el panel del contacto.
- Baja de un vendedor (tarea 00) → sus conversaciones vuelven a "sin asignar".
- Comportamiento del handoff (agente in-process y `/api/bot/handoff`).
- Tabla `quick_reply`, CRUD (Propietario) en Ajustes → "Respuestas rápidas",
  lectura para todos, atajo `/` con autocompletado en el compositor.

**Fuera de alcance**
- Reparto automático (round-robin, por carga, por horario) → decisión abierta.
- Notificaciones push/sonido al ser asignado → tarea 05 (Alertas).
- Paginación y filtros en servidor de la Bandeja → tarea 06 (hereda la
  visibilidad de aquí).
- Respuestas rápidas personales por vendedor, adjuntos en respuestas rápidas,
  estadísticas de uso.
- Restringir Contactos/Pipeline por asignación (ver D-09-1; recomendado no en
  v1).

### Historias de usuario

- Como **Vendedor** quiero ver solo mis conversaciones y las que nadie ha
  tomado, para concentrarme en mis clientes y no pisar los de mis compañeros.
- Como **Vendedor** quiero tomar una conversación sin asignar con un clic (o
  simplemente respondiéndola), para que el equipo sepa que es mía.
- Como **Vendedor** quiero liberar una conversación que no puedo atender, para
  que otro la tome.
- Como **Propietario** quiero ver todas las conversaciones con su responsable y
  reasignarlas, para repartir la carga y cubrir ausencias.
- Como **Propietario** quiero que, al dar de baja a un vendedor, sus
  conversaciones vuelvan a "sin asignar", para que ningún cliente quede
  huérfano.
- Como **Propietario** quiero definir respuestas rápidas oficiales, para que el
  equipo conteste rápido y con el tono del negocio.
- Como **Vendedor** quiero escribir `/` y elegir una respuesta rápida que ya
  traiga el nombre del cliente, para responder en segundos.

### Requisitos funcionales

**(a) Asignación y visibilidad**
- **RF-09-01** `conversation.assigned_user_id` es `NULL` (sin asignar) o el id
  de un usuario **miembro de la organización**. Las conversaciones `is_test`
  nunca se asignan.
- **RF-09-02** Visibilidad: Propietario → todas; Vendedor → `assigned_user_id IS NULL OR assigned_user_id = <yo>`.
  Se aplica en la **query** (`src/server/inbox/queries.ts`), de modo que
  cualquier endpoint (y la paginación de 06) la hereda.
- **RF-09-03** Una conversación no visible responde **404** (no 403) en todos
  los endpoints por id (no revela su existencia): `PATCH /api/conversations/:id`,
  `GET|POST .../messages`, `POST .../messages/media`, `POST .../messages/template`.
- **RF-09-04** Tomar: el Vendedor asigna a sí mismo una conversación **sin
  asignar**. Es atómico: si otro la tomó antes, responde 409 `already_assigned`
  con el nombre de quien la tiene (solo si el que pide es owner) o sin nombre
  (si es Vendedor, ya no la puede ver).
- **RF-09-05** Liberar: el Vendedor pone en `NULL` una conversación suya. El
  Propietario puede liberar cualquiera.
- **RF-09-06** Asignar/reasignar: solo el Propietario asigna a cualquier miembro
  (incluido él mismo). Un Vendedor **no** puede asignar a otro (403).
- **RF-09-07** Responder = tomar: si un Vendedor envía cualquier mensaje
  (texto, adjunto, ubicación, contacto, plantilla) a una conversación sin
  asignar, queda asignada a él en la misma operación. El reclamo atómico es la
  **compuerta** del envío: si otro vendedor la tomó entre que se abrió y se
  envió, el mensaje **no sale** (404, la conversación ya no es visible). El
  Propietario que responde **no** se auto-asigna (decisión abierta D-09-3).
- **RF-09-08** Inicio desde Contactos (`start-conversation`): si la
  conversación existente está asignada a otro → 409 `assigned_to_other` (al
  Vendedor sin nombre); si está sin asignar o es nueva y quien inicia es
  Vendedor → queda asignada a él. *Nota*: es 409 y no 404 (excepción a
  RF-09-03) porque aquí se llega desde un **contacto** que el Vendedor sí ve
  (directorio compartido, D-09-1) y necesita saber por qué no puede escribirle;
  no revela contenido. Si el dueño elige el modo estricto de D-09-1, pasa a 404.
- **RF-09-09** SSE: un Vendedor **no recibe** `message.new` ni
  `message.status` de conversaciones que no ve. `conversation.updated` viaja a
  todos **reducido a `{ conversation: { id } }`** (sin nombre, teléfono, nota
  de handoff ni responsable), para que quien perdió una conversación refresque
  su lista. `lab.run` solo al Propietario (lo hace 00).
- **RF-09-10** Adjuntos: `GET /api/media/:assetId` responde 404 al Vendedor si
  el adjunto pertenece a un mensaje de una conversación que no ve.
- **RF-09-11** `ConversationDto` incluye `assignedTo: { userId, name } | null`
  y `assignedAt`. La fila de la Bandeja muestra el responsable (owner) o "Tuya"
  / "Sin asignar" (Vendedor).
- **RF-09-12** Pastillas de la Bandeja: Todas · No leídas · Atención humana ·
  **Mías** · **Sin asignar**. `GET /api/conversations` acepta
  `?assigned=me|unassigned|all` (default `all` = todo lo visible) para que 06 lo
  use tal cual.
- **RF-09-13** El badge de no leídos del menú (`app-nav.tsx:96-103`) cuenta solo
  lo visible (sale gratis de RF-09-02).
- **RF-09-14** Baja de un vendedor (00): sus conversaciones pasan a `NULL`
  en la misma transacción que borra la membresía; se publica
  `conversation.updated` por cada una.
- **RF-09-15** Handoff (agente in-process `applyHandoff` y `/api/bot/handoff`):
  **no cambia** la asignación. Una conversación asignada sigue con su vendedor
  (que la ve en "Atención humana"); una sin asignar aparece para todos los
  vendedores en "Sin asignar" + "Atención humana" para que la tome el primero.
- **RF-09-16** Cambiar la asignación nunca toca `ai_enabled`/`handoff_at`: el
  agente sigue las mismas reglas de siempre.

**(b) Respuestas rápidas**
- **RF-09-20** `quick_reply` por organización: `shortcut` (único por org, `^[a-z0-9_-]{1,32}$`, se guarda en minúsculas), `title` (1-80), `body` (1-4096, mismo límite que el envío de texto `messages/route.ts:34`), `position`.
- **RF-09-21** CRUD solo Propietario (`withAuth(..., { role: "owner" })`); lectura
  (`GET`) para cualquier rol.
- **RF-09-22** Variables soportadas: `{{nombre}}` (primer nombre del
  contacto), `{{nombre_completo}}`, `{{vendedor}}` (nombre de quien envía),
  `{{negocio}}` (nombre de Marca). Guardar un `body` con una variable
  desconocida responde 422 indicando cuál.
- **RF-09-23** En el compositor, escribir `/` al inicio del campo o tras un
  espacio abre un selector filtrado por atajo y título; ↑/↓ navega, Enter o Tab
  inserta, Esc cierra. Con el selector abierto, Enter **inserta** (no envía).
- **RF-09-24** Al insertar se sustituyen las variables y el texto queda
  **editable** en el campo; nada se envía solo. Una variable sin valor (p. ej.
  contacto sin nombre) se sustituye por cadena vacía y se limpian espacios
  dobles.
- **RF-09-25** Ventana de 24 h: con `replyMode` `template` o `closed` el
  compositor no ofrece respuestas rápidas (solo el selector de plantillas, como
  hoy); en `free` y `human_agent` sí. El servidor ya rechaza texto libre fuera
  de ventana (`send.ts:226-228`), así que una respuesta rápida nunca evade la
  regla.
- **RF-09-26** Los chips de acceso rápido sobre el campo
  (`composer.tsx:241-260`, hoy pegan el cuerpo de una plantilla como texto
  libre) muestran las primeras 4 respuestas rápidas por `position`; si la org no
  tiene ninguna, se conserva el comportamiento actual con plantillas.

### Permisos por rol

| Acción | Propietario | Vendedor |
|---|---|---|
| Ver conversaciones de cualquier vendedor | ✅ | ❌ (404) |
| Ver/abrir conversaciones sin asignar | ✅ | ✅ |
| Ver/abrir/responder las asignadas a mí | ✅ | ✅ |
| Tomar una sin asignar | ✅ | ✅ |
| Liberar la mía | ✅ | ✅ |
| Asignar/reasignar a otro / liberar ajena | ✅ | ❌ |
| Filtros "Mías" / "Sin asignar" | ✅ | ✅ |
| Recibir eventos en vivo de conversaciones ajenas | ✅ | ❌ (solo `{id}` en `conversation.updated`) |
| Ver adjuntos de conversaciones ajenas | ✅ | ❌ (404) |
| Ver lista de respuestas rápidas / usarlas con `/` | ✅ | ✅ |
| Crear/editar/borrar/reordenar respuestas rápidas | ✅ | ❌ (403; pestaña oculta) |

**Por qué el Propietario gestiona y todos usan**: las respuestas rápidas son la
voz oficial del negocio (precios, horarios, ubicación); un catálogo único evita
duplicados y textos desactualizados, y encaja con la regla de 00 de que el
Vendedor no toca Ajustes. Si se necesitan textos personales, se agregan después
como columna aditiva (`owner_user_id`) sin romper nada (D-09-4).

### Criterios de aceptación

1. **Dado** una conversación sin asignar, **cuando** el Vendedor A y el Vendedor
   B la toman a la vez, **entonces** uno recibe 200 y el otro 409, y en BD queda
   un solo responsable.
2. **Dado** una conversación asignada a A, **cuando** B pide la lista, los
   mensajes, envía texto o plantilla o pide un adjunto de ella, **entonces** no
   aparece en la lista y todo lo demás responde 404.
3. **Dado** que B tiene abierta la conexión SSE, **cuando** entra un mensaje a
   la conversación de A, **entonces** B no recibe `message.new` con ese
   `conversationId` y A sí lo recibe con el mensaje completo.
4. **Dado** que el Propietario reasigna la conversación de A a B, **cuando**
   ocurre, **entonces** A recibe `conversation.updated { id }`, refresca y la
   conversación desaparece de su lista; B la ve en "Mías".
5. **Dado** una conversación sin asignar, **cuando** un Vendedor le responde,
   **entonces** queda asignada a él sin pasos extra.
6. **Dado** que el Propietario da de baja a B, **cuando** se completa, **entonces**
   todas las conversaciones de B aparecen en "Sin asignar" para el resto.
7. **Dado** que el agente escala a humano una conversación sin asignar,
   **cuando** ocurre, **entonces** todos los vendedores la ven en "Sin asignar" y
   en "Atención humana"; si estaba asignada a A, solo A (y el Propietario) la
   ven.
8. **Dado** una respuesta rápida `/horario` con `Hola {{nombre}}, abrimos…`,
   **cuando** el Vendedor escribe `/hor` y pulsa Enter en una conversación con
   "María López", **entonces** el campo queda con `Hola María, abrimos…` sin
   enviarse.
9. **Dado** una conversación de WhatsApp con la ventana de 24 h cerrada,
   **cuando** el Vendedor la abre, **entonces** solo ve el selector de plantillas
   y escribir `/` no está disponible.
10. **Dado** un Vendedor, **cuando** hace `POST /api/quick-replies`, **entonces**
    recibe 403; **dado** un Propietario con `{{telefono}}` en el cuerpo,
    **entonces** recibe 422 nombrando la variable.

### Casos borde y degradación

- **Asignar a un usuario que no es miembro** (o dado de baja) → 422
  `invalid_assignee`; se valida contra `member` de la org dentro del UPDATE.
- **Vendedor degradado/dado de baja con la Bandeja abierta**: sus peticiones
  fallan (00) y la lista no se corrompe; sus conversaciones ya quedaron sin
  asignar (RF-09-14).
- **Owner degradado a Vendedor** con conversaciones asignadas: las conserva
  (sigue siendo miembro).
- **Enlace directo** `/inbox?contact=<id>` (`inbox-client.tsx:110-117`) a una
  conversación ajena: no aparece en la lista; se muestra "Esta conversación la
  atiende otro vendedor" en lugar del hilo vacío.
- **SSE con la BD lenta**: el filtro por evento (consulta por PK) que falla →
  **no** se envía el evento (cerrar por defecto); el cliente se pone al día con
  el refetch de `onReconnect` / siguiente `conversation.updated`.
- **Mensaje entrante a conversación asignada** cuyo dueño está desconectado:
  sigue sin notificar a otros (05 resolverá alertas/escalamiento por tiempo).
- **Conversación de prueba** (`is_test`): fuera de la Bandeja
  (`queries.ts:43`) y fuera de toda asignación.
- **Respuesta rápida borrada mientras alguien escribe**: lo ya insertado queda
  como texto; la lista se refresca al abrir el selector de nuevo.
- **Atajo duplicado** (mayúsculas/minúsculas) → 409 `duplicate_shortcut`.
- **`/` legítimo** en un texto (p. ej. "1/2 kilo"): solo dispara al inicio o tras
  un espacio, y si no hay coincidencias el selector no se abre; Esc lo cierra y
  el `/` queda como texto.
- **Compositor sin respuestas rápidas cargadas** (GET falló): se escribe normal;
  no bloquea el envío.

## 2. Plan técnico

### Estado actual

- `conversation` (`src/lib/db/schema.ts:318-376`): sin responsable; índices
  `conversation_org_contact_real_uq` (`:371-373`) y `conversation_org_last_idx`
  (`:374`). Handoff en `handoffAt/handoffReason/handoffNote` (`:343-362`).
- Lista: `listConversations(organizationId, since?)` sin filtro por usuario ni
  paginación (`src/server/inbox/queries.ts:8-52`); ruta
  `src/app/api/conversations/route.ts:6-15`. Detalle por id:
  `getConversation(organizationId, id)` (`queries.ts:54-75`), usado por
  `messages/route.ts:13` y `conversations/[id]/route.ts:24`.
  `updateConversation` (`queries.ts:128-155`) acepta `aiEnabled/reactivate/markRead`.
- DTO: `serializeConversation` (`queries.ts:101-126`) / `ConversationDto`
  (`src/lib/types.ts:5-32`).
- Envíos: `messages/route.ts:70-104` llama `sendText/sendStructured` sin
  verificar visibilidad (los send solo validan org y sandbox,
  `src/server/inbox/send.ts:205,226-228`); igual `messages/media/route.ts:26` y
  `messages/template/route.ts:21-45`.
- Inicio desde Contactos: `contacts/[id]/start-conversation/route.ts:54-79`
  busca/crea la conversación sin dueño.
- Adjuntos: `media/[assetId]/route.ts:20-39` busca por org + id;
  `media_asset` no tiene FK a conversación (`schema.ts:432-473`); el vínculo es
  `message.media_asset_id` (`schema.ts:410-412`).
- SSE: bus por org (`src/server/events/bus.ts:45-57`), la ruta reenvía todo
  (`src/app/api/events/route.ts:40-46`). Publicadores: `ingest.ts:368-378,458-468`
  (`message.new` con el mensaje serializado completo), `send.ts:336-342`,
  `ai/pipeline.ts:217,236,350`, `status.ts:62`, `whatsapp/templates.ts:406`,
  `conversations/[id]/route.ts:27-30` (`conversation.updated` con el **DTO
  completo**: nombre, teléfono, nota de handoff), `ai/pipeline.ts:350-355`
  (`handoffReason` y `handoffNote` en el payload), `bot/handoff/route.ts:74`,
  `bot/reset/route.ts:93`, `pipeline/leads/[id]/route.ts:156`.
- Cliente: `inbox-client.tsx:119-161` — `onMessageNew` usa el payload solo si
  la conversación está seleccionada y luego refetchea la lista;
  `onConversationUpdated` **ignora** el payload y refetchea. Ya tolera un
  payload reducido.
- Filtros de la Bandeja: `ConversationFilter = "all" | "unread" | "handoff"`
  (`src/components/inbox/helpers.ts:8`), pastillas en
  `conversation-list.tsx:198-226`.
- Handoff: `applyHandoff` (`src/server/ai/pipeline.ts:325-356`) y
  `bot/handoff/route.ts:63-78`; ninguno toca responsables.
- Compositor: `src/components/inbox/composer.tsx` — retorno temprano para
  `closed` (`:202-217`) y `template` (`:219-236`, `TemplateSender`); chips de
  plantillas como texto (`:241-260`, sustituyen `{{1}}` por el primer nombre en
  `:249-251`); `textarea` con Enter = enviar (`:406-422`).
- Ids con prefijo: `src/lib/db/ids.ts:6-32` (no hay `quickReply`).

### Cambios de datos

Migración `drizzle/00NN_asignacion_respuestas_rapidas.sql` (siguiente libre,
re-ejecutable y aditiva como `0012_handoff_nota.sql`; la FK a `user` la
desqualifica `scripts/migrate.mjs:58-115`):

```sql
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "assigned_user_id" text;
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_assigned_user_id_user_id_fk') THEN
    ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk"
      FOREIGN KEY ("assigned_user_id") REFERENCES "user"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "conversation_org_assignee_idx"
  ON "conversation" ("organization_id", "assigned_user_id");

CREATE TABLE IF NOT EXISTS "quick_reply" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "shortcut" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "quick_reply_org_shortcut_uq"
  ON "quick_reply" ("organization_id", "shortcut");
CREATE INDEX IF NOT EXISTS "quick_reply_org_pos_idx"
  ON "quick_reply" ("organization_id", "position");
```

- Filas existentes: `assigned_user_id = NULL` → todo queda "sin asignar"; con
  un solo usuario (el owner) nada cambia visualmente.
- `schema.ts`: columnas nuevas en `conversation` (`:318`) + índice; tabla
  `quickReply` con `organizationId NOT NULL`. Toda query nueva usa `scoped()`.
- `src/lib/db/ids.ts`: `quickReply: "qr"`.
- Todas las escrituras de asignación son `UPDATE ... WHERE organization_id = $org AND id = $id AND <precondición> RETURNING`
  (idempotentes; repetir "tomar" sobre una ya mía devuelve 200 sin cambios).

### Servidor

**Visibilidad (núcleo de 09)**
1. `src/server/inbox/visibility.ts` (nuevo):
   - `type Viewer = { userId: string; role: Role }` (de `src/lib/roles.ts`, 00).
   - `conversationVisibleTo(viewer): SQL | undefined` → `undefined` para owner;
     `or(isNull(conversation.assignedUserId), eq(conversation.assignedUserId, viewer.userId))`
     para Vendedor.
   - `canSeeConversation(orgId, viewer, conversationId): Promise<boolean>`
     (consulta por PK, para SSE y media).
2. `src/server/inbox/queries.ts`:
   - `listConversations(organizationId, viewer, opts: { since?, assigned? })` —
     agrega `conversationVisibleTo(viewer)` y el filtro `assigned` dentro del
     `scoped()` de `:40-45`; `leftJoin(schema.user, eq(user.id, conversation.assignedUserId))`
     para `assignedTo.name`. **06 hereda esto al paginar.**
   - `getConversation(organizationId, conversationId, viewer?)` — mismo
     predicado; `viewer` obligatorio en rutas de sesión (los llamadores
     internos sin sesión —agente, bot— pasan `undefined`).
   - `serializeConversation` (`:101-126`) + `ConversationDto`
     (`types.ts:5-32`): `assignedTo`, `assignedAt`.
   - `assignConversation(orgId, id, { to: string | null, expect?: "unassigned" | userId })`:
     UPDATE condicional; devuelve `{ ok } | { conflict: currentAssignee }`;
     valida `to` contra `member` de la org (subconsulta `EXISTS` en el WHERE).
   - `claimForSend(orgId, id, userId): Promise<boolean>`:
     `UPDATE conversation SET assigned_user_id = $me, assigned_at = coalesce(assigned_at, now()) WHERE organization_id = $org AND id = $id AND is_test = false AND (assigned_user_id IS NULL OR assigned_user_id = $me) RETURNING id`.
     Es la **compuerta** del envío del Vendedor (no un efecto lateral tras
     leer): 0 filas → la ruta responde 404 y **no** llama a `sendText`. Así se
     cierra el TOCTOU entre `getConversation(viewer)` y el envío (otro vendedor
     la toma en medio). Idempotente si ya era suya.
3. Rutas (todas con la sesión de `withAuth` → `viewer = { userId, role }`):
   - `conversations/route.ts:6-15`: pasa `viewer` y `?assigned=`.
   - `conversations/[id]/route.ts`: `patchSchema` (`:8-12`) gana
     `assignedUserId: z.string().min(1).nullable().optional()`. Reglas: owner →
     cualquier miembro o null; Vendedor → solo `= self` sobre sin asignar
     (tomar) o `null` sobre la suya (liberar); otro caso 403. Primero
     `getConversation(..., viewer)` → 404 si no la ve. Publica
     `conversation.updated { conversation: { id } }` (deja de mandar el DTO
     completo, `:27-30`).
   - `conversations/[id]/messages/route.ts`: GET (`:13`) y POST (`:70`) llaman
     `getConversation(..., viewer)` → 404; en POST, si `role === "member"` →
     `if (!(await claimForSend(...))) return 404` **antes** de
     `sendText/sendStructured` (no se toca `send.ts`).
   - `messages/media/route.ts:26` y `messages/template/route.ts:21`: mismo
     patrón (404 + `claimForSend` como compuerta).
   - `contacts/[id]/start-conversation/route.ts:54-79`: leer
     `assignedUserId` de la existente; si es de otro y el que pide es Vendedor →
     409 `assigned_to_other`; tras `getOrCreateConversation`, si es Vendedor →
     `claimForSend`; 0 filas (alguien la tomó en medio) → 409
     `assigned_to_other` sin enviar la plantilla.
   - `settings/team/route.ts:11-33` (y `listMembers` de 00): exponer también
     `userId` (hoy solo `id: schema.member.id`, `:15`); el selector de
     responsable envía **user ids**, que es lo que guarda
     `assigned_user_id`.
   - `media/[assetId]/route.ts:27-39`: para Vendedor agregar
     `EXISTS (select 1 from message m join conversation c on c.id = m.conversation_id where m.media_asset_id = media_asset.id and <visible>)`;
     sin mensaje asociado → 404 para Vendedor.
4. **SSE** — `src/app/api/events/route.ts:40-46`, con la sesión que ya resuelve
   (`:15-23`):
   - owner: sin cambios (más `lab.run`).
   - Vendedor: `message.new` / `message.status` → `await canSeeConversation(...)`
     y solo entonces `send`; error de BD → descartar. `conversation.updated` →
     reenviar **siempre** pero reescrito a `{ conversation: { id } }`.
     `booking.updated` sin cambios (solo id). `lab.run` nunca.
   - Además reducir **en origen** los payloads de `conversation.updated` a
     `{ id }` en `conversations/[id]/route.ts:27` y `ai/pipeline.ts:350-355`
     (el cliente no los usa: `inbox-client.tsx:150-154`) — así ni el owner
     recibe datos de más por SSE.
   - **Por qué consulta por evento y no metadatos del publicador**: hay ≥ 10
     sitios que publican y cada uno tendría que conocer el responsable vigente
     (riesgo de dato rancio justo tras una reasignación). Una consulta por PK
     por evento y por conexión de vendedor es despreciable al volumen de un
     negocio (decenas de vendedores, no miles). Si algún día pesa, un caché por
     conexión invalidado por `conversation.updated` lo resuelve sin cambiar el
     contrato.
5. **Baja de vendedor** — implementar el hook de 00
   `onMemberRemoved(orgId, userId, tx)` en `src/server/inbox/assignment.ts`
   (nuevo): `UPDATE conversation SET assigned_user_id = NULL, assigned_at = NULL WHERE organization_id = $org AND assigned_user_id = $user RETURNING id`;
   publicar `conversation.updated { id }` por cada fila **después** del commit.
   El `ON DELETE SET NULL` cubre además un borrado físico del usuario (si el
   dueño elige D-00-1 = borrar).
6. **Handoff** — sin cambios de lógica en `applyHandoff`
   (`ai/pipeline.ts:325-356`) ni `bot/handoff/route.ts:63-78` (RF-09-15); solo
   el payload reducido del punto 4. Opcional: `GET /api/bot/context` devuelve
   `assignedTo` para que el cerebro externo sepa si hay humano a cargo (no
   rompe contrato: campo nuevo).

**Respuestas rápidas**
7. `src/lib/quick-replies.ts` (nuevo, puro, compartido cliente/servidor):
   `QUICK_REPLY_VARS = ["nombre","nombre_completo","vendedor","negocio"]`,
   `findUnknownVars(body)`, `renderQuickReply(body, ctx)`,
   `slashQuery(text, caret): { query, start } | null`,
   `matchQuickReplies(list, query)`, `normalizeShortcut()`; esquema Zod
   `quickReplyInput`.
8. `src/server/quick-replies.ts` (nuevo): `list/create/update/delete/reorder`
   con `scoped(schema.quickReply.organizationId, ...)`; 409 si choca el índice
   único.
9. Rutas (nuevas): `src/app/api/quick-replies/route.ts` (GET any, POST owner) y
   `src/app/api/quick-replies/[id]/route.ts` (PATCH, DELETE owner). Agregarlas
   a `ROUTE_POLICY` de 00 (`src/lib/permissions.ts`), si no el test de la matriz
   falla.

### UI

- **Bandeja — lista** (`src/components/inbox/conversation-list.tsx`):
  - `ConversationFilter` (`helpers.ts:8`) gana `"mine" | "unassigned"`;
    `filterConversations` (`helpers.ts:31-62`) los aplica con
    `useViewer().userId` (de 00). Pastillas nuevas en `:198-213` (en móvil ya
    hacen `flex-wrap`).
  - En la fila (`:300-350`): etiqueta "Sin asignar" / "Tuya" / avatar+nombre del
    responsable (owner).
- **Bandeja — panel/encabezado** (`inbox-client.tsx` + `contact-panel.tsx`):
  control "Responsable": Vendedor ve **Tomar** (sin asignar) o **Liberar**
  (suya); owner ve un selector con los miembros (`GET /api/settings/team`,
  owner-only tras 00, usando su campo nuevo `userId`, no `id` de membresía) +
  "Sin asignar". 409 → toast "Ya la tomó otro vendedor" y
  refetch.
- **Bandeja — enlace directo** (`inbox-client.tsx:110-117`): si `contact=` no
  está en la lista visible, mostrar el aviso de "la atiende otro vendedor".
- **Compositor** (`composer.tsx`):
  - `useQuickReplies()` (nuevo, `src/components/inbox/use-quick-replies.ts`):
    `GET /api/quick-replies` una vez, recarga al abrir el selector.
  - `src/components/inbox/quick-reply-picker.tsx` (nuevo): popover anclado al
    `textarea`, lista filtrada, `role="listbox"`, navegación con teclado.
  - En `onChange` (`:411-414`) calcular `slashQuery`; en `onKeyDown`
    (`:415-421`), si el selector está abierto: ↑/↓, Enter/Tab insertan, Esc
    cierra — **antes** del `Enter` = enviar.
  - Insertar = reemplazar `/consulta` por `renderQuickReply(body, { contacto: conversation.contact.name, vendedor: viewer.name, negocio: branding.name })` y `autogrow()`.
  - Chips (`:241-260`): respuestas rápidas por `position`; fallback a
    plantillas si no hay ninguna (RF-09-26).
  - Sin cambios en los retornos tempranos `closed`/`template` (`:202-236`):
    ahí no hay `textarea`, así que no hay `/` (RF-09-25).
- **Ajustes → "Respuestas rápidas"** (owner): página
  `src/app/(app)/settings/(owner)/quick-replies/page.tsx` (nuevo, dentro del
  grupo protegido de 00) + `src/components/settings/quick-replies-client.tsx`
  (nuevo): tabla con atajo, título, vista previa renderizada con datos de
  ejemplo, crear/editar (con ayuda de variables y error 422 en línea),
  borrar con confirmación, reordenar (subir/bajar). Pestaña en
  `settings-nav.tsx:9-14` (solo owner).
- `ViewerProvider` de 00 se amplía con `businessName` (ya llega `branding` a
  `AppShell`).

### Tareas ordenadas

- [ ] T-09-01 Schema (`conversation.assignedUserId/assignedAt` + índice, tabla `quickReply`), `ids.ts` `qr`, `pnpm db:generate` y migración re-ejecutable a mano; aplicarla 2× en la BD aislada. Dep: 00 (T-00-08, para el número).
- [ ] T-09-02 `src/server/inbox/visibility.ts` + unit. Dep: 01, 00 (`Role`).
- [ ] T-09-03 `listConversations`/`getConversation` con `viewer` + `?assigned=` + `assignedTo` en DTO/tipos; actualizar llamadores. Dep: 02.
- [ ] T-09-04 404 por visibilidad en `messages` GET/POST, `media` POST, `template` POST, `PATCH conversations/:id`. Dep: 03.
- [ ] T-09-05 `assignConversation` / `claimForSend` (compuerta) + reglas de PATCH (tomar/liberar/asignar) + "responder = tomar" en los 3 endpoints de envío. Dep: 04.
- [ ] T-09-06 `start-conversation`: 409 `assigned_to_other` + claim. Dep: 05.
- [ ] T-09-07 `media/[assetId]`: EXISTS por mensaje→conversación visible. Dep: 02.
- [ ] T-09-08 SSE: filtro por suscriptor en `/api/events` + payload reducido de `conversation.updated` en origen. Dep: 02.
- [ ] T-09-09 Hook `onMemberRemoved` (liberar al dar de baja) conectado a `removeMember` de 00. Dep: 05, 00 (T-00-10).
- [ ] T-09-10 UI Bandeja: pastillas Mías/Sin asignar, etiqueta de responsable, control Tomar/Liberar/Asignar, aviso de enlace directo. Dep: 05, 00 (T-00-14).
- [ ] T-09-11 `src/lib/quick-replies.ts` (puro) + unit. Dep: —.
- [ ] T-09-12 `src/server/quick-replies.ts` + rutas `/api/quick-replies` (+ `ROUTE_POLICY`). Dep: 01, 11, 00 (T-00-03, T-00-06).
- [ ] T-09-13 Ajustes → Respuestas rápidas (página + client + pestaña). Dep: 12, 00 (T-00-13).
- [ ] T-09-14 Compositor: selector `/`, chips, render de variables. Dep: 12.
- [ ] T-09-15 E2E `scripts/e2e-asignacion.mjs` + `scripts/e2e-respuestas-rapidas.mjs` (nuevos) + guiones `tests/e2e/us-asignacion.md` y `tests/e2e/us-respuestas-rapidas.md` (nuevos). Dep: todas.
- [ ] T-09-16 Gate completo + `pnpm test:e2e` (selftest como owner: debe seguir verde; las conversaciones quedan "sin asignar" y el owner las ve todas) + los dos E2E nuevos contra `.env.e2e`. Marcar en `dev-tasks/README.md`.

### Pruebas

**Unit (`tests/unit/`)**
- `assignment-visibility.test.ts`: `conversationVisibleTo` (owner → sin filtro;
  Vendedor → `IS NULL OR = yo`), reglas de transición del PATCH como función
  pura (`canTransition(viewer, current, target)`): Vendedor toma sin asignar ✓,
  toma ajena ✗, libera suya ✓, asigna a otro ✗; owner todo ✓.
- `sse-filter.test.ts`: con `canSeeConversation` simulado, el filtro de
  `/api/events` descarta `message.new` ajeno, reescribe `conversation.updated`
  a `{id}`, descarta `lab.run`, y descarta si la consulta lanza.
- `assignment-guard.test.ts` (guardarraíl estilo
  `stage-history-guard.test.ts`): toda llamada a `getConversation(` desde
  `src/app/api/**` **excepto** `src/app/api/bot/**` y `src/app/api/dev/**` (sin
  sesión: agente/cerebro externo/mocks) pasa un tercer argumento (`viewer`);
  falla nombrando el archivo si no. Igual para `listConversations(`.
- `claim-for-send.test.ts` (BD aislada o simulación de la query): dos
  `claimForSend` concurrentes de A y B sobre una sin asignar → exactamente uno
  `true`; el que obtiene `false` no invoca `sendText` (spy).
- `quick-replies.test.ts`: `renderQuickReply` (primer nombre, nombre vacío,
  espacios dobles, variable repetida), `findUnknownVars("{{telefono}}")`,
  `slashQuery` (inicio, tras espacio, "1/2" no dispara, caret en medio),
  `normalizeShortcut`.

**E2E — `scripts/e2e-asignacion.mjs` (nuevo; cookie jars como
`scripts/e2e-handoff-nota.mjs:20-55`, BD aislada, `WA_MOCK_ENABLED=true`)**
1. Owner entra; crea vendedores A y B (`POST /api/settings/team`); A y B entran.
2. Inbound vía `POST /api/dev/wa-mock/inbound` → conversación nueva sin
   asignar; A y B la ven (`GET /api/conversations`), `assignedTo: null`.
3. A y B la toman en paralelo (`PATCH { assignedUserId: self }`) → un 200 y un
   409; queda un responsable.
4. Supongamos A: B → no está en su lista; `GET .../messages` 404;
   `POST .../messages` 404; `POST .../messages/template` 404; adjunto
   (inbound con imagen del wa-mock) `GET /api/media/:id` 404 para B, 200 para A.
5. SSE: B abre `fetch("/api/events")` y lee el stream; inbound nuevo a la
   conversación de A → en 3 s B no recibe `message.new` con ese id; A sí
   (stream propio). B sí recibe `conversation.updated` con solo `{ id }`.
6. "Responder = tomar": inbound a un contacto nuevo; B responde texto → la
   conversación queda asignada a B. Carrera: otra sin asignar, A y B envían
   texto a la vez → uno 200 (queda suya) y el otro 404, y el outbox del
   wa-mock (`GET /api/dev/wa-mock/outbox`) tiene **un solo** mensaje.
7. Owner reasigna la de A a B → A ya no la ve, B sí; Vendedor A intenta
   asignarse una de B → 404/403.
8. Handoff: `POST /api/bot/handoff` sobre una sin asignar → visible a A y B con
   `handoffAt`; sobre una de A → solo A.
9. Baja: owner da de baja a B (`DELETE /api/settings/team/:memberId`) → sus
   conversaciones con `assignedTo: null` y visibles para A.
10. Camino infeliz: asignar a un usuario inexistente → 422; PATCH con
    `assignedUserId` a un id de otra org → 422; tomar dos veces la propia →
    200 idempotente.

**E2E — `scripts/e2e-respuestas-rapidas.mjs` (nuevo, API + Playwright como
`scripts/e2e-responsive.mjs:18,61-62`)**
1. Owner crea `/horario` (`Hola {{nombre}}, abrimos de 9 a 6. — {{vendedor}}`);
   `{{telefono}}` → 422; atajo duplicado en mayúsculas → 409.
2. Vendedor: `GET /api/quick-replies` 200; `POST`/`PATCH`/`DELETE` → 403;
   `/settings/quick-replies` → 404.
3. Playwright como Vendedor en una conversación con ventana abierta (inbound
   reciente del wa-mock): escribir `/hor` → aparece el selector; Enter →
   el campo contiene `Hola <Nombre>, …` y **no** se envió (outbox del wa-mock
   vacío, `GET /api/dev/wa-mock/outbox`); Enter otra vez → se envía y el outbox
   tiene el texto renderizado.
4. Camino infeliz: conversación con `lastInboundAt` > 24 h (sembrada) → el
   compositor muestra el selector de plantillas y no hay `textarea`; un
   `POST .../messages` con el texto de la respuesta rápida → 409
   `window_closed` (guardia existente).
- Guiones humanos `tests/e2e/us-asignacion.md` y
  `tests/e2e/us-respuestas-rapidas.md` con los mismos pasos.
- `scripts/e2e-selftest.mjs`: agregar una sección corta que verifique que
  `GET /api/conversations` trae `assignedTo` y que el owner sigue viendo todo.

### Riesgos y decisiones abiertas

- **Riesgo — un endpoint que use `getConversation` sin `viewer`** filtra
  contenido ajeno: mitigado con `assignment-guard.test.ts` y con la regla de
  404 centralizada en la query.
- **Riesgo — fuga por SSE**: hoy `message.new` lleva el texto completo
  (`ingest.ts:368-373`) y `conversation.updated` el DTO con nombre/teléfono
  (`conversations/[id]/route.ts:27-30`); mitigado con el filtro por suscriptor
  + payload reducido en origen, y probado en E2E leyendo el stream real.
- **Riesgo — coordinación con 06**: 06 debe paginar **sobre**
  `listConversations(org, viewer, ...)` sin reimplementar el predicado, y
  mover las pastillas `mine/unassigned` al servidor usando `?assigned=` ya
  existente.
- **Riesgo — conteos de pastillas**: mientras 06 no exista, los contadores se
  calculan en cliente sobre la lista visible (correcto por construcción).
- **Decisión abierta D-09-1 — ¿Contactos y Pipeline también se restringen?**
  Recomendado **no en v1**: el directorio de contactos y el tablero se
  comparten (evita duplicados al dar de alta, permite que el Vendedor mueva
  leads como pidió el dueño); el contenido de las conversaciones sí se
  restringe. Coste aceptado: un Vendedor ve nombre, teléfono, notas y ficha de
  contactos que atiende otro. Opción estricta: aplicar el mismo predicado vía
  `EXISTS` sobre la conversación real del contacto en `GET /api/contacts`,
  `GET|PATCH /api/contacts/:id` (`src/server/contacts.ts:27`) y
  `GET /api/pipeline/board` — ~1 día extra y choca con el alta de contactos
  duplicados (el 409 revelaría la existencia).
- **Decisión abierta D-09-2 — auto-asignación en handoff.** Recomendado: no
  asignar; queda en "Sin asignar" + "Atención humana" visible para todos y la
  toma el primero (RF-09-15). Alternativa: round-robin entre vendedores
  (requiere un puntero `last_assigned_user_id` por org y definir "disponible");
  dejarlo para después de 05 (alertas), que dará la señal de "nadie la tomó en X
  min".
- **Decisión abierta D-09-3 — ¿el Propietario se auto-asigna al responder?**
  Recomendado no (el dueño "supervisa" sin quitarle clientes a nadie); si el
  dueño también vende, puede tomarla explícitamente.
- **Decisión abierta D-09-4 — respuestas rápidas personales del Vendedor.**
  Recomendado no en v1 (catálogo único del Propietario). Ampliable con
  `owner_user_id` nullable (aditivo).
- **Decisión abierta D-09-5 — adjuntos**: se propone filtrar `/api/media` por
  visibilidad (RF-09-10). La alternativa barata es confiar en que los ids
  (`ma_` + 20 chars nanoid) no se adivinan; se descarta porque un id puede
  quedar en el historial del navegador de un vendedor reasignado.
- **Decisión abierta D-09-6 — ¿el Vendedor puede ceder a otro vendedor
  directamente?** Recomendado no (solo liberar; el Propietario reasigna).

## 3. Dependencias con otras tareas

- **Depende de 00 (obligatoria, antes)**: `Role`/`roleLabel` (`src/lib/roles.ts`),
  `withAuth(..., { role: "owner" })`, `ROUTE_POLICY` + `role-matrix.test.ts`
  (las rutas nuevas `/api/quick-replies*` deben clasificarse),
  `ViewerProvider`/`useViewer()`, grupo de rutas `settings/(owner)/` y el hook
  `onMemberRemoved` de `src/server/team/members.ts`. Como 00 **no borra** la
  fila `user` en la baja, el `ON DELETE SET NULL` no se dispara: liberar las
  conversaciones depende del hook (T-09-09).
- **Habilita 06 (Paginación)**: la visibilidad vive en
  `listConversations(org, viewer, ...)` y el parámetro `?assigned=`; 06 pagina
  sobre esa misma query y mueve las pastillas al servidor.
- **Habilita 05 (Alertas)**: las alertas deben dirigirse al responsable
  (`assigned_user_id`) o, sin asignar, a todos los vendedores; y el filtro SSE
  de aquí es el que 05 reutiliza para no notificar conversaciones ajenas.
- **03/04 (contexto/ficha para el agente)**: independientes; si 03 expone el
  contexto en `/api/bot/context`, puede incluir `assignedTo`.
- **02 (Métricas)**: podrá agregar métricas por vendedor (conversaciones
  atendidas, tiempo de primera respuesta) a partir de `assigned_user_id` /
  `assigned_at`; para historial completo de reasignaciones haría falta una
  bitácora (fuera de alcance aquí).
