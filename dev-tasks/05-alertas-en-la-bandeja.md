# 05 — Alertas en la Bandeja

> Estado: propuesto · Prioridad: alta · Esfuerzo: M · Migración: no (índice opcional para «Ventana por cerrar», ver Cambios de datos) · Bandera: no (cada usuario la activa en su navegador; apagada por defecto)

## 1. Especificación

### Problema / objetivo

Hoy, si la pestaña del CRM no está a la vista, nadie se entera de que entró un
mensaje o de que el agente escaló una conversación: no hay notificaciones, ni
sonido, ni contador en la pestaña. El único aviso es el badge del menú lateral
(`app-nav.tsx:87`, `:96-112`), que solo se ve con la app enfrente. Un lead que
pidió humano puede esperar horas, y la ventana de 24 h de WhatsApp se cierra sin
que nadie lo note.

Objetivo: avisar en el **navegador** (Notification API, sin email ni terceros —
Constitución II) cuando entra un mensaje y cuando una conversación pasa a
necesitar humano; mostrar el número de no leídos en el **título de la pestaña**
y un **punto en el favicon**; sonido opcional; sin duplicar avisos entre
pestañas; respetando qué conversaciones puede ver cada rol. Además, una pastilla
«Ventana por cerrar» (< 2 h de las 24 h) para rescatar conversaciones a tiempo.

### Alcance (incluye) / Fuera de alcance

Incluye:
- Notificación del sistema para: (1) **mensaje entrante** y (2)
  **conversación que pasa a necesitar humano** (handoff).
- Sonido opcional (generado con Web Audio, sin archivos de terceros).
- Contador `(N)` en el título y punto en el favicon (respetando el favicon
  white-label).
- Preferencias por usuario **por dispositivo** en `localStorage`.
- Deduplicación entre pestañas del mismo navegador.
- Filtro de visibilidad por rol/asignación aplicado en el **servidor** (canal
  SSE) para que un Vendedor no reciba eventos ajenos: lo construye 09; aquí se
  extiende al evento nuevo `conversation.handoff`.
- Pastilla «Ventana por cerrar» en la Bandeja (filtro de servidor sobre el marco
  de la tarea 06) con cuenta regresiva en el renglón.
- Degradación cuando el navegador no soporta o bloquea notificaciones.

Fuera de alcance:
- Push con la pestaña CERRADA (Service Worker + Web Push): exige servidor VAPID
  y suscripciones persistidas; se evalúa aparte (decisión D-05-5).
- Email, SMS, WhatsApp al operador o cualquier servicio externo.
- Alertar de que una ventana está por cerrar (solo filtro + cuenta regresiva).
- Preferencias sincronizadas entre dispositivos (tabla en BD).
- Alertas en la app móvil de WhatsApp Business (fuera del CRM).

### Historias de usuario

- Como **Vendedor** quiero una notificación cuando un cliente me escribe aunque
  esté en otra pestaña, para contestar antes de que se enfríe.
- Como **Propietario** quiero que me avise cuando el agente escala una
  conversación a humano, con el motivo, para tomarla de inmediato.
- Como **Vendedor** quiero que solo me avise de mis conversaciones y de las sin
  asignar, para no recibir ruido de las de mis compañeros.
- Como **Propietario o Vendedor** quiero ver «(3)» en la pestaña y un punto en
  el icono, para saber de un vistazo que hay pendientes.
- Como **Propietario o Vendedor** quiero activar o apagar el sonido y elegir de
  qué me avisa, para adaptarlo a mi forma de trabajar.
- Como **Propietario o Vendedor** quiero filtrar las conversaciones cuya
  ventana de 24 h está por cerrar, para escribirles antes de necesitar una
  plantilla.

### Requisitos funcionales

- **RF-05-01** El permiso de notificaciones se pide **solo** tras un gesto del
  usuario (clic en «Activar notificaciones»); nunca al cargar la página.
- **RF-05-02** Con permiso concedido y la preferencia encendida, un
  `message.new` con `direction = "in"` de una conversación visible genera una
  notificación con: nombre del contacto, vista previa (si «Mostrar contenido»
  está encendido; si no, «Nuevo mensaje»), icono = favicon de la marca y
  `tag = "conv:<conversationId>"` (los mensajes seguidos de la misma
  conversación reemplazan la notificación, no se apilan).
- **RF-05-03** Una conversación que pasa a necesitar humano genera una
  notificación «Necesita atención humana» con el motivo en español
  (`handoffLabel`, `src/lib/handoff-labels.ts:28-33`) y la nota si existe. El
  motivo `manual_reply` (el dueño contestó desde el teléfono) **no** alerta:
  ya hay un humano atendiendo.
- **RF-05-04** No se notifica si la pestaña que decide está enfocada y tiene
  abierta esa misma conversación en la Bandeja.
- **RF-05-05** Clic en la notificación: enfoca la pestaña y abre
  `/inbox?contact=<contactId>` con esa conversación seleccionada.
- **RF-05-06** Con varias pestañas abiertas, cada evento produce **como máximo
  una** notificación y **un** sonido (clave de dedupe = `message.id` para
  entrantes; `handoff:<conversationId>:<handoffAt>` para handoffs).
- **RF-05-07** El título de TODAS las pestañas muestra `(N) ` delante del título
  de la marca cuando N > 0 (N = mismo número que el badge del menú, ver
  D-05-1), y vuelve al título normal con N = 0. Sobrevive a la navegación entre
  páginas de la app.
- **RF-05-08** Con N > 0 el favicon muestra un punto sobre el icono de la marca
  (subido o generado); con N = 0 vuelve al original.
- **RF-05-09** Sonido opcional (apagado por defecto), máximo uno cada 3 s.
- **RF-05-10** Preferencias en `localStorage` (`vocero.alerts.v1`):
  notificaciones on/off, entrantes on/off, handoffs on/off, sonido on/off,
  mostrar contenido on/off, contador en pestaña on/off.
- **RF-05-11** Un Vendedor solo recibe por SSE eventos de conversaciones
  visibles para él (asignadas a él o sin asignar, tarea 09); el filtro se
  aplica en `/api/events`, no en el navegador.
- **RF-05-12** Conversaciones del Laboratorio (`is_test`) nunca alertan.
- **RF-05-13** Pastilla «Ventana por cerrar» en la Bandeja: conversaciones con
  último entrante hace más de 22 h y menos de 24 h; contador en la pastilla; el
  renglón muestra «Cierra en 1h 12m» recalculado cada minuto a partir de
  `lastInboundAt` (no del `windowRemainingMs` serializado, que envejece).
- **RF-05-14** Si el navegador no soporta notificaciones o están bloqueadas, el
  panel de alertas lo dice con instrucciones y lo demás (título, favicon,
  sonido) sigue funcionando.

### Permisos por rol

| Recurso | Propietario: ver | Propietario: editar | Vendedor: ver | Vendedor: editar |
|---|---|---|---|---|
| Alertas de mensaje entrante | Todas las conversaciones | Sus preferencias | Asignadas a él + sin asignar | Sus preferencias |
| Alertas de handoff | Todas | Sus preferencias | Asignadas a él + sin asignar | Sus preferencias |
| Contador en título/favicon | Todas | — | Solo lo visible | — |
| Pastilla «Ventana por cerrar» | Todas | — | Solo lo visible | — |
| Eventos SSE recibidos | Todos los de la org | — | Solo de lo visible | — |

### Criterios de aceptación

- **CA-05-01** Dado que activé notificaciones y estoy en /pipeline, cuando entra
  un mensaje de «Ana», entonces aparece una notificación «Ana» con el texto, y
  al hacer clic se abre /inbox con la conversación de Ana seleccionada.
- **CA-05-02** Dado que tengo tres pestañas del CRM abiertas, cuando entra un
  mensaje, entonces se muestra exactamente una notificación y suena una vez; las
  tres pestañas muestran «(1) …» en el título.
- **CA-05-03** Dado que tengo abierta en primer plano la conversación de Ana,
  cuando Ana escribe, entonces no hay notificación ni sonido.
- **CA-05-04** Dado que el agente escala con motivo `cliente`, cuando ocurre,
  entonces llega «Necesita atención humana — El cliente pidió un humano»; dado
  que contesto desde el teléfono (`manual_reply`), entonces no llega nada.
- **CA-05-05** Dado un Vendedor y una conversación asignada a otro vendedor,
  cuando ese cliente escribe, entonces el navegador del primer Vendedor no
  recibe el evento SSE (verificable leyendo el stream) ni notifica, y su
  contador no cambia.
- **CA-05-06** Dado que bloqueé las notificaciones del sitio, cuando abro el
  panel de alertas, entonces veo «Bloqueaste las notificaciones en este
  navegador…» con instrucciones, y al entrar un mensaje el título igual pasa a
  «(1) …».
- **CA-05-07** Dado que una corrida del Laboratorio escala una conversación de
  prueba, entonces no hay notificación ni cambia el contador.
- **CA-05-08** Dado una conversación con último entrante hace 23 h, cuando elijo
  «Ventana por cerrar», entonces aparece con «Cierra en 59m» (aprox.), y una con
  último entrante hace 10 h no aparece; al pasar las 24 h sale sola del filtro
  en ≤ 1 min.
- **CA-05-09** Dado N = 2 no leídos, cuando abro una de las dos conversaciones,
  entonces el título pasa a «(1) …» en todas las pestañas y el punto sigue; al
  abrir la otra, desaparecen contador y punto.

### Casos borde y degradación

- **`Notification` no existe** (iOS Safari fuera de PWA, navegadores viejos) o
  `!window.isSecureContext` (HTTP) → se oculta el interruptor de
  notificaciones con el motivo; título, favicon y sonido funcionan.
- **Permiso `denied`** → nunca se vuelve a pedir (el navegador no lo
  permitiría); texto con instrucciones (candado de la barra de direcciones).
- **Permiso revocado después** → al detectar `permission !== "granted"` en el
  siguiente evento, la preferencia se muestra apagada sin error.
- **Audio bloqueado por autoplay** → el `AudioContext` se crea/reanuda en el
  mismo clic que activa las alertas; si después está `suspended`, se omite el
  sonido en silencio.
- **Ráfaga** (cliente manda 10 mensajes seguidos) → una notificación por
  conversación (mismo `tag`, se reemplaza) y un sonido cada ≥ 3 s.
- **Web Locks no disponible** → la dedupe cae a `BroadcastChannel` con
  desempate por `tabId` (ver Servidor/UI); sin `BroadcastChannel` (muy viejo),
  cada pestaña decide sola y el `tag` de la notificación evita apilarlas en el
  sistema operativo.
- **Favicon no dibujable** (error de carga, formato raro) → solo se actualiza
  el título; jamás se queda un icono roto.
- **SSE caído** → no hay alertas mientras tanto; al reconectar se refrescan
  contadores (título/favicon correctos) pero **no** se disparan notificaciones
  retroactivas de lo perdido (evita avalancha).
- **Preferencias corruptas en localStorage o acceso bloqueado** → try/catch y
  valores por defecto (todo apagado salvo el contador del título).
- **Varios usuarios en el mismo navegador** → la clave incluye el `userId`
  (`vocero.alerts.v1.<userId>`).

## 2. Plan técnico

### Estado actual

- SSE: `src/app/api/events/route.ts:14-75` suscribe al bus **por organización**
  (`:24`, `:40-46`) aunque conoce `userId` y `role` de la sesión; el `id` del
  evento es `Date.now()` por conexión (`:43`), distinto en cada pestaña. Bus en
  `src/server/events/bus.ts:9-57`.
- Cliente SSE: `src/components/use-events.ts:32-74` abre **un `EventSource`
  por cada hook** (`:37`); hoy hay dos por página (menú `app-nav.tsx:109-112` y
  Bandeja `inbox-client.tsx:119-161`).
- `message.new` lleva el DTO del mensaje con `direction`
  (`ingest.ts:458-464` entrante; `send.ts:336-342` saliente;
  `ingest.ts:368-374` eco manual). El sandbox del Laboratorio no publica
  `message.new` (`pipeline.ts:298-318`), pero `applyHandoff`
  (`pipeline.ts:325-356`) sí publica `conversation.updated` también para
  `is_test`.
- Escrituras de handoff: `applyHandoff` (`pipeline.ts:325-356`, llamado en
  `:142` ventana, `:148` cliente, `:189` error, `:264` modelo, `:290`
  ventana); pausa por respuesta manual `ingest.ts:345-358` (`manual_reply`);
  cerebro externo `src/app/api/bot/handoff/route.ts:64-77`. Payloads de
  `conversation.updated` inconsistentes (ver 06).
- Badge del menú: `app-nav.tsx:96-103` suma `unreadCount` de la lista completa.
- Título: `generateMetadata` en `src/app/layout.tsx:22` (`${branding.name} — CRM
  de WhatsApp`) y favicon en `:26` vía `faviconHref`
  (`src/lib/favicon.ts:128-130`, mismo origen `/api/branding/favicon?v=`).
- Shell: `src/components/app-shell.tsx:23-111` monta `AppNav` (`:74`) en todas
  las páginas autenticadas — buen lugar para un hook global.
- Ventana: `windowRemainingMs` se calcula al serializar
  (`queries.ts:120`, `window.ts:19-26`); `formatRemaining` ya existe
  (`helpers.ts:79-85`). Todas las capacidades de canal tienen `windowMs` de 24 h
  (`capabilities.ts:58`, `:69`, `:82`).
- No existe nada de Notification API, `BroadcastChannel`, Web Locks ni sonido en
  el código.

### Cambios de datos

- **Sin migración obligatoria.** Preferencias en `localStorage` por dispositivo:
  el permiso de notificaciones ya es por navegador, así que una preferencia en
  BD no ahorraría el paso de «Activar» en cada equipo.
- Opcional (si la Bandeja supera miles de conversaciones): índice para la
  pastilla «Ventana por cerrar», idealmente dentro de la migración de 06:
  ```sql
  CREATE INDEX IF NOT EXISTS "conversation_org_inbound_idx"
    ON "conversation" ("organization_id", "last_inbound_at")
    WHERE "is_test" = false;
  ```

### Servidor

1. **Helper de handoff único — `src/server/inbox/handoff.ts` (nuevo)**:
   `markHandoff({ organizationId, conversationId, reason, note, isTest,
   source })` que hace el `UPDATE` actual y, si **no** es `is_test`, publica
   el evento nuevo `conversation.handoff` `{ conversationId, reason,
   handoffAt }` además de `conversation.updated { id }`. Payload mínimo a
   propósito, en línea con 09 (RF-09-09): nombre, teléfono y nota NO viajan por
   el bus; la pestaña que va a notificar los pide con
   `GET /api/conversations?ids=<id>` (06), que aplica visibilidad. Para
   `is_test` no publica nada (cierra el hueco actual de `pipeline.ts:350`).
   Reemplaza las escrituras de `applyHandoff` (`pipeline.ts:325-356`),
   `ingest.ts:345-358` y `bot/handoff/route.ts:64-77`, respetando sus
   condiciones actuales (solo si no había handoff abierto). Es **el mismo
   punto** donde la tarea 02 (variante V2) inserta en
   `conversation_handoff_event`: quien llegue primero crea el helper.
2. **Tipo de evento** en `src/server/events/bus.ts:9-32`: agregar
   `{ type: "conversation.handoff"; data: {...} }`; en `use-events.ts:5-25`,
   `onConversationHandoff`. Actualizar `specs/001-vocero-core/contracts/sse.md`.
3. **Filtro de visibilidad en el SSE — lo implementa 09** (T-09-08,
   `src/app/api/events/route.ts:40-46`): para el Vendedor, `message.new` y
   `message.status` pasan solo si `canSeeConversation(orgId, viewer, id)`
   (`src/server/inbox/visibility.ts`, **nuevo, tarea 09**);
   `conversation.updated` viaja a todos reducido a `{ id }`. Esta tarea solo
   **agrega `conversation.handoff` a la lista de eventos filtrados** con la
   misma regla que `message.new` (un Vendedor no debe enterarse de que escaló
   una conversación ajena). Opcional: caché por conexión del resultado de
   `canSeeConversation` (TTL ~10 s, invalidada por `conversation.updated` de
   ese id) si la medición muestra carga.
4. **Pastilla «Ventana por cerrar»** sobre el marco de 06: agregar
   `filter=closing` al parseo (`src/server/inbox/list-query.ts`, nuevo en 06)
   con predicado calculado en Node (las columnas son `timestamp` sin zona y el
   resto del código compara en JS, `window.ts:10-16`):
   `last_inbound_at > $now - 24h AND last_inbound_at <= $now - 22h`
   (generalizable por canal con `capabilitiesFor(channel).windowMs`; canales
   sin ventana quedan fuera). Agregar `closing` a `GET
   /api/conversations/counts` (06).

### UI

- **`src/lib/alerts.ts` (nuevo, lógica pura y testeable)**:
  `loadPrefs(userId)` / `savePrefs` (try/catch, defaults), `shouldNotify({
  event, prefs, permission, focusedTabHasConversationOpen })`,
  `notificationContent(event, prefs)` (usa `previewText` de `helpers.ts:109-112`
  y `handoffLabel`), `dedupeKey(event)`, `titleWithCount(base, n)`.
- **`src/components/alerts/use-inbox-alerts.ts` (nuevo)** — hook montado UNA vez
  en `app-shell.tsx` (junto a `AppNav`, `:74`):
  - Escucha `onMessageNew` (filtra `direction === "in"`; el texto del mensaje
    ya viene en el evento, que 09 solo entrega si es visible),
    `onConversationHandoff` y `onReconnect`. El nombre del contacto (y la nota
    del handoff) se obtienen con `GET /api/conversations?ids=<id>` (06) solo en
    la pestaña que va a notificar; si no vuelve (no visible), no se notifica.
  - `userId` para la clave de preferencias desde `useViewer()`
    (`src/components/viewer-context.tsx`, **nuevo, tarea 00**).
  - **Coordinación entre pestañas**: `navigator.locks.request("vocero:alerts",
    …)` elige una pestaña líder que emite notificación y sonido; las pestañas
    publican su foco y la conversación abierta por
    `BroadcastChannel("vocero:alerts")` para que la líder aplique RF-05-04.
    Respaldo sin Web Locks: cada pestaña anuncia `{key, tabId}` y gana el
    `tabId` menor tras 150 ms. Clave = `dedupeKey` (no el `id` del SSE).
  - `new Notification(title, { body, icon, tag, data: { contactId } })`;
    `onclick` → `window.focus()` + `router.push("/inbox?contact=…")`.
  - Sonido: `AudioContext` + dos osciladores cortos (~150 ms), creado/
    reanudado en el clic de activación; throttle 3 s.
- **`src/components/alerts/use-unread-indicator.ts` (nuevo)** — en TODAS las
  pestañas: obtiene N de `GET /api/conversations/counts` (06) al montar, en cada
  `message.new`/`conversation.updated` (debounce 500 ms), en `onReconnect` y en
  `visibilitychange`; aplica:
  - Título: `titleWithCount(base, N)`; re-aplica en cambio de `pathname` y con
    un `MutationObserver` sobre `<title>`, porque Next reescribe el título al
    navegar (`layout.tsx:22`).
  - Favicon: `src/lib/favicon-badge.ts` (nuevo) carga el `href` actual del
    `<link rel="icon">` (mismo origen, no contamina el canvas), lo dibuja en un
    canvas 64×64, agrega un punto (color de alerta fijo con borde blanco para
    contrastar con cualquier acento — D-05-3) y cambia el `href` a un data URL;
    con N = 0 restaura el original. Cualquier error → no toca el favicon.
  - Sustituye el `refetchUnread` del menú (`app-nav.tsx:96-112`): el badge lee
    el mismo N (lo deja 06 hecho; aquí se comparte el estado vía un contexto
    pequeño para no pedir `counts` dos veces).
- **Un solo `EventSource` por pestaña** — `src/components/events-provider.tsx`
  (nuevo): `useEvents` (`use-events.ts:32-74`) pasa a suscribirse a un
  proveedor montado en `AppShell` en vez de abrir su propia conexión. Reduce de
  3 a 1 las conexiones SSE por pestaña (menú + Bandeja + alertas). Recomendado
  pero separable (D-05-4).
- **Panel de alertas** — `src/components/alerts/alerts-menu.tsx` (nuevo):
  botón de campana en el pie del menú lateral (zona de usuario,
  `app-nav.tsx:~260-280`) con popover:
  - Estado del permiso: `default` → botón «Activar notificaciones» (llama
    `Notification.requestPermission()` y desbloquea audio en el mismo clic);
    `granted` → interruptores; `denied` → instrucciones; sin soporte → motivo.
  - Interruptores de RF-05-10 y botón «Probar» (notificación + sonido de
    ejemplo).
  - Aviso único y descartable en la Bandeja («Activa las alertas para enterarte
    aunque estés en otra pestaña») mientras el permiso sea `default`.
- **Pastilla «Ventana por cerrar»** en `conversation-list.tsx:198-230` (después
  de las de 09 «Mías»/«Sin asignar», RF-09-12; con contador de `counts.closing`) y chip «Cierra en …» en el
  renglón (`:325-353`) usando `formatRemaining` con un reloj de 60 s que
  recalcula desde `lastInboundAt`; mientras la pastilla está activa, el mismo
  reloj saca filas vencidas y refresca `counts`. Con 6 pastillas en 360 px el
  contenedor ya hace `flex-wrap` (`:196-198`); verificar con
  `scripts/e2e-responsive.mjs` (D-05-7).

### Tareas ordenadas

- [ ] **T-05-01** `src/lib/alerts.ts` (prefs, decisión, contenido, dedupe,
  título) + unit tests. *(—)*
- [ ] **T-05-02** `src/server/inbox/handoff.ts` `markHandoff` + evento
  `conversation.handoff` (bus, `use-events`, `sse.md`), sin eventos para
  `is_test`; reemplazar las 3 escrituras. *(—; coordinar con 02)*
- [ ] **T-05-03** Agregar `conversation.handoff` al filtro SSE por visibilidad
  de 09 (misma regla que `message.new`) + test. *(09: T-09-08)*
- [ ] **T-05-04** `events-provider.tsx` y migrar `useEvents` a una sola
  conexión. *(—; D-05-4)*
- [ ] **T-05-05** `favicon-badge.ts` + `use-unread-indicator.ts` (título +
  favicon + badge compartido). *(06: `counts`)*
- [ ] **T-05-06** `use-inbox-alerts.ts`: líder entre pestañas, notificación,
  sonido, clic → `/inbox?contact=`. *(T-05-01, T-05-02, T-05-04)*
- [ ] **T-05-07** `alerts-menu.tsx` + aviso en Bandeja + estados de permiso.
  *(T-05-06)*
- [ ] **T-05-08** Filtro `closing` en servidor + `counts.closing` + pastilla y
  cuenta regresiva en la lista. *(06)*
- [ ] **T-05-09** Pruebas (abajo) + gate `pnpm typecheck && pnpm lint && pnpm
  build && pnpm test` + E2E en BD aislada (`.env.e2e`). *(todo)*

### Pruebas

Unit (`tests/unit/`, entorno `node` de `vitest.config.ts:7` → solo lógica pura):
- `alerts.test.ts` (nuevo): `shouldNotify` — saliente → no; `manual_reply` →
  no; conversación abierta y pestaña enfocada → no; permiso `denied` → no;
  preferencia apagada → no; entrante normal → sí. `notificationContent` con y
  sin «Mostrar contenido», con adjunto («📎 Imagen»). `dedupeKey` estable.
  `titleWithCount` (0 → sin prefijo, 1, 99+, título que ya trae prefijo).
  `loadPrefs` con JSON corrupto → defaults.
- `handoff-event.test.ts` (nuevo): `markHandoff` con `isTest` no publica; sin
  handoff previo publica `conversation.handoff` una vez; con handoff abierto no
  re-publica (idempotencia).
- `inbox-closing.test.ts` (nuevo): predicado de «Ventana por cerrar» en los
  bordes (22 h exactas, 24 h exactas, sin entrantes).

E2E — **`scripts/e2e-alertas.mjs` (nuevo)** + guion
**`tests/e2e/us-alertas.md` (nuevo)**; app viva con mocks (`WA_MOCK_ENABLED=true`,
wa-mock + ai-mock, `BOT_API_KEY` en `.env.e2e`):
1. Contexto Playwright con `permissions: ["notifications"]` y
   `addInitScript` que reemplaza `window.Notification` por un registrador
   (headless no muestra notificaciones reales) y `AudioContext` por un
   contador.
2. Dos páginas del mismo contexto en `/pipeline` y `/contacts`; activar alertas
   y sonido desde el panel en una de ellas.
3. `POST /api/dev/wa-mock/inbound` → exactamente **1** notificación sumando
   ambas páginas, 1 sonido, título de ambas empieza con «(1)», el
   `<link rel=icon>` es `data:image/png…`.
4. Abrir la conversación en la Bandeja (pestaña enfocada) y mandar otro
   entrante → 0 notificaciones nuevas.
5. Handoff: `POST /api/bot/handoff` (motivo cliente) → 1 notificación con
   «Necesita atención humana»; eco manual (`/api/dev/wa-mock/echo`) → 0.
6. Laboratorio: lanzar una corrida corta (ai-mock) → 0 notificaciones, título
   sin cambio.
7. «Ventana por cerrar»: entrante con `timestamp` de hace 23 h (wa-mock acepta
   `timestamp`, `src/app/api/dev/wa-mock/inbound/route.ts:22`) y otro de hace
   10 h → la pastilla muestra 1 y el renglón «Cierra en …».
8. Camino infeliz: contexto nuevo con `Notification.permission = "denied"` →
   el panel muestra el texto de bloqueo y el título igual pasa a «(1)»;
   `Notification` indefinido → interruptor oculto, sin errores en consola;
   SSE cortado (`setOffline`) + entrante + reconexión → título correcto y 0
   notificaciones retroactivas.
9. Con 09: segunda cuenta Vendedor; leer `/api/events` con `fetch` en streaming
   y verificar que un entrante en una conversación asignada a otro **no**
   aparece en el stream.
- Agregar el guion al arnés `scripts/e2e-selftest.mjs` / `pnpm test:e2e`.

### Riesgos y decisiones abiertas

- **D-05-1** ¿Qué cuenta N en título/favicon: **mensajes** no leídos (suma de
  `unread_count`, igual que el badge actual `app-nav.tsx:102`) o
  **conversaciones** con no leídos (como WhatsApp Web)? Recomendado:
  conversaciones (más estable y legible), cambiando también el badge para que
  coincidan.
- **D-05-2** ¿«Ventana por cerrar» incluye TODAS las conversaciones con < 2 h o
  solo las que esperan respuesta (último mensaje entrante)? Recomendado: todas,
  con la marca de no leído visible; reconsiderar tras uso real.
- **D-05-3** Color del punto del favicon: rojo fijo (máximo contraste, es lo
  que el usuario reconoce como «pendiente») vs color de acento de la marca
  (white-label, pero se pierde sobre un icono del mismo color). Recomendado:
  rojo con borde blanco.
- **D-05-4** Unificar el `EventSource` (proveedor) en esta tarea o aparte. Sin
  unificar, cada pestaña abre 3 conexiones SSE y la Bandeja recibe cada evento
  3 veces; recomendado hacerlo aquí.
- **D-05-5** Notificaciones con la pestaña cerrada (Service Worker + Web Push
  con claves VAPID propias, sin terceros — el servicio de push es el del
  navegador). Es posible sin violar soberanía pero es otra tarea (L).
- **D-05-6** «Mostrar contenido» encendido por defecto o apagado (privacidad en
  pantallas compartidas). Recomendado: encendido, se puede apagar.
- **D-05-7** Con las pastillas de 09 la fila llega a 6 («Todas», «No leídas»,
  «Atención humana», «Mías», «Sin asignar», «Ventana por cerrar»): ¿se quedan
  todas como pastillas (dos renglones en móvil) o «Ventana por cerrar» y
  «Atención humana» pasan a un menú «Más filtros»? Recomendado: pastillas, y
  revisar en 375 px.
- **Riesgo**: el filtro SSE del Vendedor (de 09) hace una consulta por PK por
  evento y conexión de Vendedor; agregar `conversation.handoff` suma muy poco.
  Con pocas decenas de usuarios por instancia es despreciable.
- **Riesgo**: si se implementa antes que 06, el contador saldría de la lista
  completa como hoy; por eso el orden recomendado es 06 → 05.

## 3. Dependencias con otras tareas

- **00 — Roles y permisos** (antes): `Role` normalizado en la sesión (hoy
  `session.role` es texto libre, `src/lib/auth/session.ts:5-9`) y
  `useViewer()` (`src/components/viewer-context.tsx`, **nuevo, tarea 00**) para
  el `userId` de la clave de preferencias.
- **09 — Asignación** (antes): filtro SSE por visibilidad con
  `canSeeConversation` (T-09-08, RF-09-09), payload `conversation.updated { id }`
  y pastillas «Mías»/«Sin asignar». 05 solo suma `conversation.handoff` al
  filtro.
- **06 — Paginación** (antes): `GET /api/conversations/counts` (N del título,
  `closing`), marco de filtros de servidor para la pastilla, `?ids=` para
  obtener nombre/nota de la conversación a notificar.
- **02 — Métricas** (después): comparte `markHandoff`; la variante V2 de 02
  agrega ahí la inserción en `conversation_handoff_event`.
