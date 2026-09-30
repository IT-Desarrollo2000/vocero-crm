# E2E — Canales de Instagram y Messenger (014 / 017)

Guion de comportamiento observable. Automatizado en `canalesChecks()` de
`scripts/e2e-selftest.mjs`: con la app viva y los mocks encendidos,
`pnpm test:e2e` lo conduce y sale distinto de cero si algo falla.

**Preparación**: app en `localhost` con `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` e `IG_GRAPH_BASE_URL` → wa-mock graph, `BOT_API_KEY`,
`META_APP_SECRET` (para ejercitar la firma) y la BD migrada. La variable
`CHANNELS` decide qué mitad corre para cada canal: **las dos se ejercitan**.

Nada toca Meta. El mock reconoce sufijos de token para los caminos infelices:
`-invalid` (401, token revocado), `-id<n>` (token de otra cuenta), `-down`
(5xx) y `-nohumanagent` (Meta rechaza la etiqueta de agente humano).

Cada paso corre igual para Instagram (`/ig`, `object: "instagram"`) y para
Messenger (`/fb`, `object: "page"`).

---

## US1 — La instancia decide si el canal existe

Con el canal fuera de `CHANNELS`:

1. `GET /api/settings/<canal>` → **404**.
2. `POST /api/webhooks/<ig|fb>/<token>` → **404**.
3. La pantalla `/settings/<canal>` → 404, y Ajustes no muestra su pestaña.

## US2 — Conectar

1. Un token inválido → 422 y no se guarda nada.
2. Un token de otra cuenta (`-id999`) → 422 `id_mismatch`.
3. Un token bueno se guarda. `GET` devuelve solo sus últimos 4 caracteres, nunca el token.
4. La respuesta trae la URL del webhook del canal; la pantalla `/settings/<canal>` existe.

## US3 — Recibir

1. Firma falsa → 401. Segmento equivocado → 404. El handshake devuelve el `hub.challenge`.
2. Un DM firmado crea **una** conversación con el canal correcto y un contacto
   sin teléfono, con el nombre de respaldo `Contacto de <Canal>`.
3. La re-entrega del mismo `mid`, un eco (`is_echo`) y un evento de lectura no
   agregan mensajes: hay un solo entrante.
4. Un segundo mensaje del mismo remitente cae en la misma conversación.
5. El DTO dice `replyMode: "free"`, `templates: false`, `outboundMedia: false`.

## US4 — Responder

1. La respuesta del operador llega al transporte del canal con
   `recipient.id` = el remitente, por la cuenta conectada, sin etiqueta (en
   Messenger con `messaging_type: RESPONSE`).
2. El mensaje queda `sent`: estos canales no mandan acuses por id.
3. Un texto que excede el límite (1000 bytes en Instagram, 2000 caracteres en
   Messenger) → 422 con el motivo.
4. Ubicación y adjunto → **422 `unsupported_channel`**, nunca 500.
5. Iniciar con plantilla a un contacto de este canal → 422.

## US5 — Fuera de las 24 h

1. Un cliente que escribió hace 3 días: `replyMode: "human_agent"`, y la
   respuesta sale con `messaging_type: MESSAGE_TAG` + `tag: HUMAN_AGENT`.
2. Hace 8 días: `replyMode: "closed"`; enviar → 409 `window_closed` con el
   motivo de los 7 días, **sin** intentar el envío.

## US6 — El proveedor falla y la operación sigue

1. Sin la función Human Agent aprobada: la respuesta fuera de ventana → 409
   que lo nombra, no un error genérico.
2. Plataforma caída → 503 `meta_unavailable`, y la conexión **no** queda
   marcada como muerta.
3. Token revocado después de guardarse → 409 `reconnect_required`; la
   conexión queda pidiendo reconectar y los envíos siguientes se pausan sin
   llamar a Meta.
