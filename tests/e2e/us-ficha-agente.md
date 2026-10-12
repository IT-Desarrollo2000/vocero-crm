# E2E — El agente llena la ficha (tarea 04)

Automatizado en `scripts/e2e-ficha-agente.mjs`
(`node --env-file=.env.e2e scripts/e2e-ficha-agente.mjs`). El paso del
cerebro externo sobre el candado humano también vive en
`scripts/e2e-ficha-lead.mjs`.

Precondición: app corriendo con mocks (`WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL` → ai-mock con token y
modelo de relleno), BD aislada (Postgres :5433, `.env.e2e`) con la migración
`0014_ficha_campos` aplicada, agente in-process encendido. `BOT_API_KEY` (≥16)
habilita el paso 7.

El ai-mock, cuando el prompt trae la sección `CAMPOS DE LA FICHA`, responde a
un mensaje con modelo (T03/Macaron/Bingo/Nammi) y "soy de / vivo en / aquí en
<ciudad>" con `{"action":"reply","text":"…","ficha":{"modelo_interes":…,"ciudad":…}}`.
Además, sin depender de la definición: "ficha-update" → alias
`{"action":"update_ficha","reply":"Anotado","ficha":{"presupuesto":"350 mil"}}`
y "ficha-rota" → `{"action":"reply","text":"ok","ficha":"no soy un objeto"}`.

## Definición de campos (Propietario)

1. `PUT /api/agent/ficha-fields` con la plantilla de autos eléctricos → 200
   con los 6 campos en forma canónica; `GET` la devuelve.
2. Una clave repetida → 422 `invalid_body`.

## El agente llena sin gastar el turno

3. Inbound "me interesa el T03, soy de Villahermosa" → el cliente recibe la
   respuesta; `GET /api/contacts/{id}` → `ficha.modelo_interes = "T03"`,
   `ficha.ciudad = "Villahermosa"`, `fichaMeta.*.by = "ia"`, `fichaFields`
   con la definición; historial con 2 eventos `aplicado` de la IA.

## El humano gana

4. `PATCH` humano `ficha: {presupuesto: 500000}` → `fichaMeta.presupuesto.by
   = "humano"` (candado).
5. Inbound "ficha-update" → el cliente recibe "Anotado"; `presupuesto` sigue
   en 500000 y el historial trae `ignorado_humano` / `candado_humano`.
6. `PATCH` `fichaUnlock: ["presupuesto"]` → valor intacto, `by = "ia"`;
   inbound "ficha-update" → `presupuesto = 350000` (número, coerción de
   "350 mil").

## Camino infeliz

7. Inbound "ficha-rota" → el cliente recibe "ok"; la conversación no escala.

## Cerebro externo (D-04-4)

8. Humano fija `ciudad = "Mérida"`; `PUT /api/bot/ficha` con
   `{ciudad:"Cancún", urgencia:"alta"}` → 200, `ignored` trae
   `{key:"ciudad", reason:"candado_humano"}`, `ciudad` sigue "Mérida" y
   `urgencia` entra con `by = "bot"`. `GET /api/bot/context` trae
   `contact.fichaMeta` y `fichaFields`.

## Historial y permisos

9. `GET /api/contacts/{id}/ficha/history` → eventos más reciente primero; los
   humanos con `actor.name`.
10. El Propietario da de alta un Vendedor (`POST /api/settings/team`); como
    Vendedor: `PUT`/`GET /api/agent/ficha-fields` → 403; historial → 200;
    detalle del contacto trae `fichaFields`; `PATCH` de ficha → 200 con
    candado.

## Sin definición

11. `PUT /api/agent/ficha-fields` con `[]` → `fields: null`; inbound con
    modelo y ciudad → respuesta normal y la ficha no cambia. El guion termina
    SIEMPRE con `fields: null` para no afectar a los demás guiones de la BD
    compartida.

## Laboratorio (AC-12)

12. Con la plantilla aplicada (antes del paso 11), el guion espera a que no
    haya corridas en curso (`GET /api/lab/runs`, ninguna `running`), lanza
    `POST /api/lab/runs` → 202 con `runId` y sondea
    `GET /api/lab/runs/{id}` hasta `done`/`failed` (tope 180 s). En el
    detalle, el caso de `comprador_decidido` trae `fichaCheck` con
    `cumplidos` ⊇ `["modelo_interes","ciudad"]` (el ai-mock llena el modelo
    con "Me interesa el Leapmotor T03…" y la ciudad con "…aquí en
    Villahermosa"). Con modelo real (manual): `pregunton_precios` espera
    `modelo_interes ≈ Macaron|Bingo`. Es informativo: no entra al score del
    juez.
