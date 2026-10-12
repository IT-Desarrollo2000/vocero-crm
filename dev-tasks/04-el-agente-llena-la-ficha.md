# 04 — El agente llena la ficha

> Estado: en curso (contrato 04-0 fijado) · Prioridad: alta · Esfuerzo: L · Migración: sí (`0014_ficha_campos`) · Bandera: no de despliegue — el llenado se activa por campo al definir la ficha (sin campos definidos, el agente no llena nada)

## 1. Especificación

### Problema / objetivo

La ficha del lead (`contact.ficha`, `src/lib/db/schema.ts:149`) existe, se ve y
se edita en la Bandeja (`src/components/ficha-panel.tsx`), y el panel promete
que "el agente la va llenando" (`src/components/inbox/contact-panel.tsx:81-83`).
Pero **solo la llena un cerebro externo** vía `PUT /api/bot/ficha`. El agente
in-process no tiene ninguna acción para escribirla: lo más cercano es
`update_lead`, que agrega texto suelto a `contact.notes` y además **le quita el
turno** (una acción por turno; `reply` es opcional, `src/server/ai/actions.ts:11-15`).

Tampoco hay definición de campos: las claves son libres por diseño
(`src/server/bot/ficha.ts:9-13`), así que no hay forma de decirle al agente qué
preguntar ni de validar lo que guarde. Y no hay procedencia: si el dueño corrige
"presupuesto" y el agente vuelve a escribirlo, hoy gana el último en escribir
(`mergeFicha`, `ficha.ts:67-74`).

**Objetivo**: que el Propietario defina los campos de la ficha (nombre, tipo,
opciones, pista para el agente), que el agente los llene durante la
conversación SIN gastar el turno, que lo que edite un humano nunca lo pise el
agente, que cada cambio quede en una bitácora, y que el panel muestre qué llenó
el agente. Todo tolerante a salidas raras del modelo: un dato mal formado se
descarta, jamás tumba la respuesta al cliente.

### Alcance (incluye) / Fuera de alcance

**Incluye**
- Definición de campos por organización (migración), editable por el
  Propietario en Agente → "Campos de la ficha", con plantilla por defecto para
  agencia de autos eléctricos.
- Campo `ficha` opcional en TODAS las acciones del agente (acompaña a `reply`,
  `move_stage`, `handoff`, etc.), más tolerancia a `{"action":"update_ficha"}`.
- Coerción y validación por tipo DESPUÉS de aceptar la acción.
- Procedencia por campo (agente / humano / cerebro externo) y regla "el humano
  gana", aplicada en la puerta única `upsertFicha`.
- Bitácora append-only de cambios de ficha (incluye intentos ignorados).
- Panel: campos definidos en orden, vacíos visibles, chip "IA", candado de
  "editado por el equipo", controles por tipo, historial.
- Contrato del cerebro externo: definición de campos y procedencia en
  `/api/bot/context`; respuesta de `PUT /api/bot/ficha` con claves ignoradas.
- Laboratorio: verificación de llenado por persona.

**Fuera de alcance**
- Que el agente escriba `lead.amount_cents`, `priority`, el nombre del contacto
  o la etapa por esta vía (presupuesto ≠ monto de la negociación).
- Campos de tipo lista/objeto (la ficha sigue siendo de escalares,
  `ficha.ts:28`).
- Reglas condicionales ("si forma_pago = financiamiento, pregunta enganche").
- Métricas de llenado (las consume 02).
- Migrar o renombrar claves ya guardadas.

### Historias de usuario

- Como **Propietario** quiero definir qué datos califican a un lead (modelo de
  interés, presupuesto, forma de pago, plazo, ciudad, uso) con su tipo y
  opciones, para que el agente sepa qué averiguar y lo guarde ordenado.
- Como **Propietario** quiero arrancar con una plantilla de agencia de autos
  eléctricos y ajustarla, para no configurar desde cero.
- Como **Vendedor** quiero abrir una conversación y ver la ficha ya llenada por
  el agente, con lo que falta a la vista, para llamar al cliente sabiendo qué
  preguntar.
- Como **Vendedor** quiero corregir un dato y que el agente no lo vuelva a
  cambiar, para confiar en la ficha.
- Como **Vendedor** quiero distinguir qué llenó el agente y qué confirmó el
  equipo, y ver el historial de cambios, para saber qué tan confiable es cada
  dato.
- Como **Propietario** quiero que si el modelo manda un dato mal formado el
  cliente reciba su respuesta igual, para que la ficha nunca cueste una venta.

### Requisitos funcionales

- **RF-04-01** — La organización tiene una definición de campos de ficha:
  lista ordenada de `{ key, label, type, options?, allowOther?, hint?, agentFills }`
  con `type ∈ texto | numero | si_no | opcion`; máx. 25 campos; `key` en
  snake_case ASCII, única, ≤ 60 (coincide con `MAX_KEY_LEN`, `ficha.ts:24`);
  `label` ≤ 60; `hint` ≤ 200; `options` 2–20 de ≤ 60.
- **RF-04-02** — Sin definición (NULL), todo se comporta como hoy: ficha libre
  editable a mano y por el cerebro externo; el agente in-process NO llena nada y
  su prompt no menciona la ficha como acción.
- **RF-04-03** — Plantilla "Agencia de autos eléctricos" aplicable con un botón:
  | key | label | type | opciones / pista |
  |---|---|---|---|
  | `modelo_interes` | Modelo de interés | texto | pista: "modelo exacto que mencione el cliente" |
  | `presupuesto` | Presupuesto (MXN) | numero | pista: "monto total que dice poder pagar; no el enganche" |
  | `forma_pago` | Forma de pago | opcion | contado · financiamiento · arrendamiento · por definir |
  | `plazo_compra` | Plazo de compra | opcion | esta semana · este mes · 1 a 3 meses · más de 3 meses · solo explorando |
  | `ciudad` | Ciudad | texto | |
  | `uso` | Uso principal | opcion (allowOther) | traslado diario en ciudad · carretera · negocio / flotilla · reparto |
- **RF-04-04** — Toda acción del agente acepta un campo opcional
  `ficha: { <key>: valor }`. Una acción `{"action":"update_ficha", …}` se
  acepta y se traduce a `reply` (si trae `reply`/`text`) o `none`, conservando
  `ficha`. Un `ficha` que no sea objeto se ignora sin invalidar la acción.
- **RF-04-05** — Coerción por tipo, posterior a aceptar la acción:
  - clave: exacta → sin acentos/mayúsculas → contra `label` en snake_case;
    claves fuera de la definición o con `agentFills=false` se descartan.
  - `numero`: acepta número o texto tipo "$350,000", "350 mil", "350k",
    "1.2 millones"; si no se puede, se descarta.
  - `si_no`: sí/si/true/1/yes ↔ no/false/0.
  - `opcion`: coincidencia sin acentos/mayúsculas; si no coincide y
    `allowOther`, se guarda el texto; si no, se descarta.
  - `texto`: recortado a 200 para lo que escribe el agente.
  - `null` o "" del agente: se ignoran (el agente no borra).
- **RF-04-06** — Procedencia por campo en `contact.ficha_meta`:
  `{ [key]: { by: "ia" | "humano" | "bot", at, userId? } }`. Los VALORES de
  `contact.ficha` no cambian de forma (siguen siendo escalares planos).
- **RF-04-07** — Regla "el humano gana": si `ficha_meta[key].by = "humano"`, una
  escritura del agente (`ia`) sobre esa clave se ignora. Una clave con valor y
  SIN meta (dato anterior a esta tarea) se trata como humana (no se pisa). El
  agente sí puede corregir lo que él mismo escribió.
- **RF-04-08** — Un humano "devuelve" un campo al agente borrándolo o con la
  acción "Dejar que el agente lo actualice" (quita el candado sin borrar el
  valor: `by` pasa a `ia`).
- **RF-04-09** — Bitácora append-only `ficha_event`: una fila por clave cuyo
  valor cambió o cuyo intento se ignoró, con `source`, `actorUserId`,
  `conversationId`, valor anterior y nuevo, y `outcome ∈ aplicado | ignorado_humano | invalido`.
  Reenviar el mismo valor no genera fila.
- **RF-04-10** — La escritura de ficha del agente ocurre DESPUÉS de entregar la
  respuesta al cliente y dentro de `try/catch`: cualquier error se registra
  (claves, nunca valores) y el turno termina normal. Nunca provoca handoff.
- **RF-04-11** — El prompt del agente lista los campos con `agentFills=true`
  (key, tipo, opciones, pista) y las reglas: "incluye `ficha` solo con datos que
  el cliente dijo explícitamente; no deduzcas; no repitas valores ya guardados;
  no toques campos marcados 'confirmado por el equipo'; sigue respondiendo
  normal". La tarea 03 hace visible la ficha actual con esa marca.
- **RF-04-12** — Panel de la Bandeja: campos definidos primero, en su orden y
  con su `label`, incluidos los vacíos ("—"); luego las claves libres. Chip "IA"
  en valores con `by=ia` (tooltip: "Lo llenó el agente · fecha"); candado en
  `by=humano`. Edición con control por tipo (texto, número, Sí/No, selector).
  Botón "Historial" con la bitácora del contacto.
- **RF-04-13** — Toda escritura humana (Bandeja) pasa por `upsertFicha` con
  `source:"humano"` y `userId`; queda con candado.
- **RF-04-14** — `GET /api/bot/context` agrega `contact.fichaMeta` y
  `fichaFields` (la definición). `PUT /api/bot/ficha` agrega a su respuesta
  `ignored: [{ key, reason }]`. Ambos cambios ADITIVOS.
- **RF-04-15** — En conversaciones `is_test` (Laboratorio) el agente llena la
  ficha del contacto sintético igual que en producción: es escritura en la BD
  propia, no toca ninguna API externa, así que NO se agrega ningún bloqueo de
  sandbox. El contacto sintético se reinicia por caso (RF-03-14), incluida
  `ficha_meta` y sus eventos.
- **RF-04-16** — Todas las lecturas/escrituras nuevas pasan por `scoped()`; la
  escritura de `contact.ficha` y `ficha_meta` sigue viviendo SOLO en
  `src/server/bot/ficha.ts` (guardarraíl `tests/unit/ficha-guard.test.ts:50-66`).

### Permisos por rol

| Elemento | Propietario | Vendedor |
|---|---|---|
| Definición de campos (Agente → Campos de la ficha) | ver / editar | ver solo lo que pinta el panel (labels, opciones); no edita, no ve la pantalla de Agente |
| Aplicar plantilla de autos eléctricos | sí | no |
| Valores de la ficha en la Bandeja (campos definidos) | ver / editar / borrar | ver / editar / borrar |
| Agregar claves libres fuera de la definición | sí | sí (como hoy) — ver decisión abierta |
| Quitar candado ("Dejar que el agente lo actualice") | sí | sí |
| Historial (bitácora) de la ficha del contacto | ver | ver |
| `agentFills` por campo (qué llena el agente) | editar | no |

Los permisos de visibilidad de la conversación misma (las suyas + sin asignar)
los fija 00/09; la ficha hereda los del contacto.

### Criterios de aceptación

1. **Dado** la plantilla aplicada y una conversación real, **cuando** el cliente
   escribe "me interesa el Leapmotor T03, vivo en Villahermosa" y el modelo
   responde `{"action":"reply","text":"…","ficha":{"modelo_interes":"Leapmotor T03","ciudad":"Villahermosa"}}`,
   **entonces** el cliente recibe la respuesta, la ficha queda con ambos valores,
   `ficha_meta` los marca `ia`, hay 2 eventos `aplicado` y el panel los muestra
   con chip "IA" sin recargar (SSE).
2. **Dado** que un Vendedor editó `ciudad = "Mérida"`, **cuando** el agente manda
   `ficha: {ciudad: "Villahermosa"}`, **entonces** `ciudad` sigue "Mérida" y hay
   un evento `ignorado_humano`.
3. **Dado** `ficha: "no soy un objeto"` o `ficha: {presupuesto: "mucho"}`,
   **cuando** el agente responde, **entonces** el cliente recibe el `reply`, no
   hay handoff `error`, y (en el segundo caso) hay un evento `invalido` para
   `presupuesto`.
4. **Dado** `ficha: {presupuesto: "350 mil"}` con tipo `numero`, **entonces** se
   guarda `350000` (número).
5. **Dado** `ficha: {forma_pago: "Financiamiento"}`, **entonces** se guarda
   `"financiamiento"`; **dado** `{forma_pago: "trueque"}` sin `allowOther`,
   **entonces** se descarta con evento `invalido`.
6. **Dado** el modelo devuelve `{"action":"update_ficha","ficha":{…},"reply":"Perfecto"}`,
   **entonces** se trata como `reply` "Perfecto" + ficha.
7. **Dado** una organización sin definición de campos, **cuando** el agente toma
   un turno, **entonces** su prompt no menciona `ficha` como campo de acción y
   el `ficha` que mande se ignora.
8. **Dado** un dato anterior a la migración sin meta, **cuando** el agente
   intenta cambiarlo, **entonces** se ignora (`ignorado_humano`).
9. **Dado** un Vendedor que pulsa "Dejar que el agente lo actualice" en
   `ciudad`, **cuando** el agente manda otra ciudad, **entonces** se aplica.
10. **Dado** un Vendedor, **cuando** intenta `PUT /api/agent/ficha-fields`,
    **entonces** recibe 403.
11. **Dado** la escritura de ficha lanza excepción (BD caída a mitad), **cuando**
    el agente responde, **entonces** el mensaje al cliente ya salió y el turno
    no escala.
12. **Dado** la persona `comprador_decidido` en el Laboratorio con la plantilla,
    **cuando** termina el caso, **entonces** el reporte muestra
    `modelo_interes ≈ T03` y `ciudad = Villahermosa` llenados por el agente.

### Casos borde y degradación

- **Carrera humano/agente**: el humano guarda mientras el turno escribe. Se
  resuelve con transacción + `SELECT … FOR UPDATE` del contacto en
  `upsertFicha`; la regla de procedencia se evalúa dentro de la transacción.
- **El agente repite el valor en cada turno**: sin cambio → sin evento ni SSE.
- **El cliente cambia de opinión** ("mejor el Bingo"): el agente puede corregir
  su propio valor (evento `aplicado` con valor anterior).
- **Campo renombrado o borrado de la definición**: los valores guardados no se
  tocan; se muestran como claves libres. Cambiar el `type` no convierte datos.
- **Clave de la definición que choca con una clave libre existente**: se adopta
  el valor existente (y su meta); sin meta → cuenta como humana.
- **Ficha en el tope** (40 claves, `ficha.ts:23`): las claves definidas tienen
  prioridad; si no cabe, `invalido` con razón `tope`.
- **`handoff` con ficha**: se aplica la ficha (le sirve al humano que hereda).
- **Agenda/move_stage con ficha** que se degradan (`degradeAction`,
  `actions.ts:79-90`): la ficha se conserva en la acción degradada.
- **PII en logs**: los `console.error` mencionan claves y tipo de error, nunca
  valores (Constitución I).
- **Modelos que razonan (`<think>`)**: sin cambio; `extractJson` ya los limpia
  (`src/lib/ai/index.ts:138-167`).

## 2. Plan técnico

### Estado actual (qué existe hoy, con rutas:línea)

| Pieza | Dónde | Observación |
|---|---|---|
| Columna ficha | `src/lib/db/schema.ts:141-149` | jsonb libre, sin definición ni procedencia. |
| Puerta única | `src/server/bot/ficha.ts:87-120` (`upsertFicha`), `normalizeFicha` `:35-64`, `mergeFicha` `:67-74`, topes `:23-25` | Select + update sin transacción; sin `source`. |
| Guardarraíl | `tests/unit/ficha-guard.test.ts:35-66` | Nadie más que la puerta escribe `contact.ficha`; la puerta usa `scoped()`. |
| Cerebro externo | `src/app/api/bot/ficha/route.ts:10-15` (`z.record(z.unknown())`), `:23-55` | Merge libre, gana el último. |
| Contexto externo | `src/app/api/bot/context/route.ts:112-136` | Devuelve `ficha` plana. |
| Edición humana | `src/app/api/contacts/[id]/route.ts:46` (parche), `:57-62` (por `upsertFicha`) | No registra quién. |
| Panel | `src/components/inbox/contact-panel.tsx:116-131` (`saveFicha`), `:316` (`<FichaPanel>`), refresco SSE `:75-92` | |
| Componente | `src/components/ficha-panel.tsx` (208 líneas) | Lista ordenada alfabéticamente (`src/lib/ficha.ts:61-63`), edición de texto, "Agregar" libre, borrar. |
| Presentación | `src/lib/ficha.ts:13-58` (`fichaLabel`, `parseFichaValue`), tipos `src/lib/types.ts:88-95` | |
| Acciones | `src/server/ai/actions.ts:8-26` (base), `:38-47` (agenda), `:50-60` (unión + esquema por turno), `:79-90` (`degradeAction`) | `z.object` descarta claves desconocidas: un `ficha` hoy se pierde en silencio. |
| Turno | `src/server/ai/pipeline.ts:184-191` (`chatJson`; 3 fallos → handoff `error`), `:247-267` (switch) | Un Zod estricto para la ficha convertiría un dato raro en handoff. |
| Perfil del agente | `schema.ts:571-588` (`agent_profile`, UNIQUE por org) · API `src/app/api/agent/profile/route.ts` · UI `src/components/agent/agent-client.tsx` (tarjetas "Comportamiento" `:135`, "Knowledge base" `:239`) | |
| Bitácora análoga | `src/server/leads/stage-history.ts` + `lead_stage_event` `schema.ts:244-315` | Patrón append-only con `source` y guardarraíl. |
| ai-mock | `src/server/dev/ai-mock.ts:46-71` | Sin rama de ficha. |
| E2E existente | `scripts/e2e-ficha-lead.mjs`, guion `tests/e2e/us1-inbox.md` (sección ficha) | Prueba merge bot/dueño. |
| Laboratorio | `src/server/lab/personas.ts` (6 personas), `src/server/lab/runner.ts:274-354` | Contacto sintético reutilizado entre corridas. |

### Cambios de datos (si aplica)

Migración nueva (generada con `pnpm db:generate`; hoy la última es
`drizzle/0012_handoff_nota.sql`, así que sería **0013** salvo que 00/09 entren
antes). Aditiva, re-ejecutable, sin backfill:

```sql
ALTER TABLE agent_profile ADD COLUMN ficha_fields jsonb;      -- NULL = ficha libre
ALTER TABLE contact       ADD COLUMN ficha_meta   jsonb;      -- NULL = sin procedencia

CREATE TABLE ficha_event (
  id               text PRIMARY KEY,                -- prefijo fe_
  organization_id  text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id       text NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  conversation_id  text REFERENCES conversation(id) ON DELETE SET NULL,
  key              text NOT NULL,
  old_value        jsonb,
  new_value        jsonb,                           -- NULL = borrado
  source           text NOT NULL,                   -- ia | humano | bot
  actor_user_id    text REFERENCES "user"(id) ON DELETE SET NULL,
  outcome          text NOT NULL,                   -- aplicado | ignorado_humano | invalido
  reason           text,                            -- clave_desconocida | tipo | opcion | tope | …
  created_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX ficha_event_org_contact_idx ON ficha_event (organization_id, contact_id, created_at);

ALTER TABLE agent_test_case ADD COLUMN ficha_check jsonb;    -- { esperados, llenados } del Laboratorio
```

- `ficha_fields` vive en `agent_profile` (una fila por org, `agent_profile_org_uq`)
  en vez de una tabla: la definición se lee y escribe completa, son ≤ 25
  elementos, y una tabla no compra nada. Esquema Zod `FichaFieldDef` en
  `src/lib/ficha-fields.ts` (nuevo, compartido cliente/servidor).
- `ficha_meta` es un sidecar: NO se toca la forma de `contact.ficha`, que es
  contrato publicado en `/api/bot/context` y que `parseFichaValue` asume plana.
- `newId` gana `fichaEvent: "fe"` (`src/lib/db/ids.ts:6-30`).
- La plantilla de autos eléctricos es una constante en código, no un seed: no
  todas las instancias son agencias de autos.

### Servidor

1. **`src/lib/ficha-fields.ts` (nuevo)** — `FichaFieldDef` (Zod, RF-04-01),
   `FICHA_TEMPLATE_AUTOS_ELECTRICOS`, y `coerceFichaPatch(raw, fields)` pura:
   resuelve claves (RF-04-05), convierte tipos y devuelve
   `{ patch, rejected: [{ key, reason }] }`. Sin valores en `reason`.
2. **`src/server/bot/ficha.ts` (la puerta)**
   - `upsertFicha` gana `source: "ia" | "humano" | "bot"`, `userId?`,
     `conversationId?`, `fields?` y `unlock?: string[]`. Dentro de
     `db.transaction`: `SELECT ficha, ficha_meta … FOR UPDATE` (por `scoped()`),
     aplica `normalizeFicha` → (si `source="ia"`) `coerceFichaPatch` → regla de
     procedencia (RF-04-07) → `mergeFicha` → actualiza `ficha` + `ficha_meta` →
     inserta filas `ficha_event` solo por cambios e ignorados. Devuelve
     `{ ficha, meta, ignored }`.
   - `resetTestContact` (introducida en 03) también limpia `ficha_meta` y los
     eventos del contacto sintético.
   - Llamadores actuales: `contacts/[id]/route.ts:57-62` pasa `source:"humano"`,
     `userId: session.userId`; `bot/ficha/route.ts` pasa `source:"bot"` (ver
     decisión abierta sobre si el bot respeta el candado).
3. **`src/server/ai/actions.ts`**
   - `const FichaPatch = z.record(z.unknown()).optional().catch(undefined)`; cada
     objeto de `baseActions` y `agendaActions` se extiende con `ficha: FichaPatch`
     (helper `withFicha`).
   - `AgentAction`/`agentActionSchema` envueltos en `z.preprocess` que mapea
     `action:"update_ficha"` → `reply` (con `reply`/`text`) o `none` (RF-04-04).
   - `degradeAction` (`:79-90`) conserva `ficha` en la acción degradada.
   - Actualizar `specs/001-vocero-core/contracts/ai.md` (contrato de acciones).
4. **`src/server/ai/prompts.ts`** — `buildAgentSystemPrompt` recibe
   `fichaFields?: FichaFieldDef[]`; si hay campos con `agentFills`, agrega a
   `:60-74` la línea "Cualquier acción puede incluir `"ficha":{…}`" + la lista de
   campos y las reglas de RF-04-11. Sin campos: nada (RF-04-02).
5. **`src/server/ai/pipeline.ts`**
   - Lee `profile.fichaFields` (ya carga el perfil en `:113-119`).
   - Tras ejecutar la acción (después de `deliverReply` en cada rama: agenda
     `:215`, move_stage `:240-242`, switch `:247-267`, incluido `none` y
     `handoff`), llama `applyAgentFicha(...)`: `try { upsertFicha({ source:"ia", … }) } catch { console.error("[agente] ficha no guardada:", claves) }`.
     Si hubo cambios, `publish(organizationId, { type: "conversation.updated", … })`
     para que el panel refresque (ya escucha ese evento).
   - Recomendado: reestructurar el final del turno en
     `executeAction(...)` + `applyAgentFicha(...)` para no repetir la llamada en
     cada `return`.
6. **APIs**
   - `GET/PUT /api/agent/ficha-fields` (nuevo): `withAuth` + solo Propietario
     (guard de 00; hoy `session.role !== "owner"`, patrón en
     `src/app/api/settings/team/route.ts:43`). PUT valida con `FichaFieldDef[]`
     estricto (aquí sí: es input humano, 422 con detalle).
   - `GET /api/contacts/[id]` (`route.ts:17-34`): agrega `fichaFields` y
     `contact.fichaMeta` (vía `serializeContact`, `src/server/contacts.ts:7-24`).
   - `PATCH /api/contacts/[id]`: acepta `fichaUnlock?: string[]` (RF-04-08).
   - `GET /api/contacts/[id]/ficha/history` (nuevo): últimos 50 `ficha_event`,
     por `scoped()`, visible para ambos roles (respetando la visibilidad de
     contacto de 00/09).
   - `GET /api/bot/context` y `PUT /api/bot/ficha`: campos aditivos (RF-04-14).
7. **ai-mock** (`src/server/dev/ai-mock.ts`), ramas nuevas antes del eco:
   - último `user` menciona un modelo conocido (T03/Macaron/Bingo/Nammi) y el
     system trae la sección de campos → `reply` + `ficha:{modelo_interes:…}`;
     si menciona "vivo en <ciudad>" → `ficha:{ciudad:…}`.
   - contiene "ficha-rota" → `{"action":"reply","text":"ok","ficha":"no soy objeto"}`.
   - contiene "ficha-update" → `{"action":"update_ficha","reply":"Anotado","ficha":{"presupuesto":"350 mil"}}`.
8. **Laboratorio** — `Persona` gana `expectFicha?: Record<string, RegExp>`
   (`comprador_decidido`: `modelo_interes: /t03/i`, `ciudad: /villahermosa/i`,
   `uso: /ciudad|diario/i`; `pregunton_precios`: `modelo_interes: /macaron|bingo/i`,
   `forma_pago: /financ/i`). Al cerrar el caso, `runner.ts` lee la ficha del
   contacto sintético y guarda `agent_test_case.ficha_check = { esperados, llenados }`
   (columna nueva de la migración; NO dentro de `transcript`, que alimenta al juez). Es un chequeo
   determinista, independiente del juez, y solo informativo (no entra al score).

### UI

- **Agente → "Campos de la ficha"** (`src/components/agent/agent-client.tsx`,
  tarjeta nueva entre "Comportamiento" y "Knowledge base"; solo Propietario):
  tabla editable (label, key autogenerada y editable, tipo, opciones como
  chips, pista, interruptor "El agente lo llena"), reordenar con flechas,
  botón "Usar plantilla: agencia de autos eléctricos" (con confirmación si ya
  hay campos), contador 0/25. Texto de ayuda: "Si no defines campos, el agente
  no llena la ficha".
- **Bandeja → Ficha** (`src/components/ficha-panel.tsx`):
  - Props nuevas: `fields`, `meta`, `onUnlock`, `onShowHistory`.
  - Orden: definidos (en su orden, con `label`, vacíos como "—" en gris) →
    libres (alfabético, como hoy con `fichaEntries`).
  - Chip "IA" (icono `Sparkles`, acento `#25D366` atenuado) si `by=ia`;
    candado (`Lock`) si `by=humano`, con menú "Dejar que el agente lo
    actualice".
  - Edición por tipo: `Input` texto/número, Sí/No segmentado, `select` para
    opciones (+ "Otro…" si `allowOther`). `parseFichaValue` sigue sirviendo a
    las claves libres.
  - "Historial" abre una lista compacta: fecha, campo, antes → después,
    quién (Agente / nombre del usuario / Bot), y los ignorados en gris con su
    razón.
- **`contact-panel.tsx`**: guarda `fields` y `meta` de `GET /api/contacts/[id]`
  en `refetch`/`refreshLive` (`:57-63`, `:75-92`); `saveFicha` no cambia de
  firma.
- **Laboratorio**: en el detalle del caso, línea "Ficha: 2/3 campos esperados"
  con los valores.

### Tareas ordenadas

- [x] T-04-00 Contrato 04-0 (ver sección abajo): DTOs en `src/lib/types.ts`, `ROUTE_POLICY` de las rutas nuevas y stubs 501 con su guarda.
- [x] T-04-01 `src/lib/ficha-fields.ts` (nuevo): `FichaFieldDef`, plantilla, `coerceFichaPatch` (+ `fichaWriteBlocked`, regla de procedencia pura).
- [x] T-04-02 Unit `tests/unit/ficha-coerce.test.ts` (nuevo): claves (exacta/acentos/label), número ("350 mil", "$1,200,000", "1.2 millones", "mucho"), si_no, opción (+allowOther), texto largo, null/"" ignorados, clave desconocida.
- [x] T-04-03 Esquema Drizzle (`agent_profile.fichaFields`, `contact.fichaMeta`, tabla `fichaEvent`, `agent_test_case.fichaCheck`) + `pnpm db:generate` (`drizzle/0014_ficha_campos.sql`, editada a mano re-ejecutable) + prefijo `fe` en `ids.ts`.
- [ ] T-04-03b Verificar re-ejecución (2×) de `0014` sobre la BD aislada (:5433).
- [ ] T-04-04 `upsertFicha` con `source`/procedencia/transacción/bitácora/`unlock`; `resetTestContact` limpia meta y eventos. Actualizar llamadores (`contacts/[id]`, `bot/ficha`).
- [ ] T-04-05 Unit `tests/unit/ficha-provenance.test.ts` (nuevo): humano gana, legado sin meta protegido, ia corrige lo suyo, unlock, sin cambios → sin evento; `ficha-guard.test.ts` sigue verde.
- [ ] T-04-06 `actions.ts`: `withFicha`, `.catch`, `z.preprocess` de `update_ficha`, `degradeAction` conserva ficha. Unit en `tests/unit/agent-actions-ficha.test.ts` (nuevo): ficha basura no invalida la acción.
- [ ] T-04-07 `prompts.ts`: sección de campos solo con `agentFills`.
- [ ] T-04-08 `pipeline.ts`: `applyAgentFicha` tras la entrega, `try/catch`, SSE si cambió. Unit: excepción en `upsertFicha` → reply entregado, sin handoff.
- [ ] T-04-09 APIs: `/api/agent/ficha-fields` (solo Propietario), `GET /api/contacts/[id]` con `fichaFields`/`fichaMeta`, `fichaUnlock` en PATCH, `/api/contacts/[id]/ficha/history` (nuevo), aditivos en `/api/bot/context` y `/api/bot/ficha`.
- [ ] T-04-10 UI Agente: tarjeta "Campos de la ficha" + plantilla.
- [ ] T-04-11 UI Bandeja: `FichaPanel` con campos, chips, candado, controles por tipo, historial. Extender `tests/unit/ficha-ui.test.ts`.
- [ ] T-04-12 ai-mock: ramas de ficha, ficha-rota, update_ficha.
- [ ] T-04-13 Laboratorio: `expectFicha` + `fichaCheck` en el caso + línea en el reporte.
- [ ] T-04-14 E2E `scripts/e2e-agente-ficha.mjs` (nuevo) + guion `tests/e2e/us-agente-ficha.md` (nuevo); enganchar en `scripts/e2e-selftest.mjs`; ajustar `scripts/e2e-ficha-lead.mjs` si cambia la regla del bot (decisión abierta).
- [ ] T-04-15 Docs: `README.md` (contrato `/api/bot/*`), `specs/001-vocero-core/contracts/ai.md`, `tests/e2e/us-bot-api.md`.
- [ ] T-04-16 Gate completo + `pnpm test:e2e` en BD aislada + corrida del Laboratorio con modelo real.

### Pruebas

- **Unit (`tests/unit/`)**: `ficha-coerce.test.ts`, `ficha-provenance.test.ts`,
  `agent-actions-ficha.test.ts`, extensión de `ficha-ui.test.ts`,
  `bot-gateway.test.ts` (aditivos) y `ficha-guard.test.ts` intacto (la nueva
  escritura vive dentro de la puerta). Un test de vigilancia análogo al de
  etapas: nadie inserta en `ficha_event` fuera de `src/server/bot/ficha.ts`.
- **E2E con ai-mock** — `scripts/e2e-agente-ficha.mjs` (nuevo) + guion
  `tests/e2e/us-agente-ficha.md` (nuevo), app viva con mocks en Postgres :5433:
  1. `PUT /api/agent/ficha-fields` con la plantilla (como Propietario).
  2. inbound "me interesa el Leapmotor T03, vivo en Villahermosa" → saliente IA
     existe; `GET /api/contacts/:id` → `ficha.modelo_interes`, `ficha.ciudad`,
     `fichaMeta.*.by = "ia"`; historial con 2 `aplicado`.
  3. `PATCH` humano `ciudad: "Mérida"` → inbound "vivo en Villahermosa" →
     `ciudad` sigue "Mérida"; historial con `ignorado_humano`.
  4. `fichaUnlock: ["ciudad"]` → mismo inbound → `ciudad = Villahermosa`.
  5. inbound "ficha-rota" → saliente "ok" entregado; conversación SIN handoff.
  6. inbound "ficha-update" → saliente "Anotado"; `presupuesto === 350000`.
  7. Org sin definición (`PUT` con `[]`/null) → inbound con modelo → ficha sin
     cambios.
  8. Como Vendedor: el script crea el usuario con `POST /api/settings/team`
     (el Propietario da correo y contraseña; inserta `role:"member"`,
     `src/app/api/settings/team/route.ts:71-79`), inicia sesión con él y
     verifica `PUT /api/agent/ficha-fields` → 403 y `PATCH` de ficha → 200. Si
     00 cambia el alta de miembros, este paso usa el arnés de 00.
- **Laboratorio como regresión de comportamiento** (modelo real): con la
  plantilla, `comprador_decidido` y `pregunton_precios` deben llenar sus
  `expectFicha` en ≥ 2 de 3 corridas; el score del juez no baja respecto a la
  corrida posterior a 03; ninguna persona escala por `error`.
- **Camino infeliz**: ficha no-objeto, tipos imposibles, claves desconocidas,
  tope de 40 claves, excepción en la escritura, carrera humano/agente (unit con
  dos `upsertFicha` concurrentes sobre la BD de pruebas), proveedor que
  devuelve `<think>` + JSON con ficha.

### Riesgos y decisiones abiertas

- **Alucinación de datos**: el modelo puede "deducir" un presupuesto. Mitigan
  la regla explícita del prompt, la pista por campo, el chip "IA" (el humano
  sabe que no está confirmado) y el `expectFicha` del Laboratorio. Se puede
  medir falsos positivos con una persona que NO da datos (p. ej.
  `pide_humano`: su ficha debe quedar vacía).
- **Tokens**: +≈150–250 tokens por turno con 6 campos.
- **Concurrencia**: `FOR UPDATE` serializa escrituras por contacto; volumen
  bajo, sin riesgo de contención real.
- **D-04-4 · Decisión abierta (dueño)**: ¿el **cerebro externo** (`PUT /api/bot/ficha`)
  también respeta el candado humano? Recomendación: sí (misma regla, con
  `ignored` en la respuesta), pero cambia el comportamiento de un contrato
  publicado y el paso "Nadie le pisa el trabajo al otro" de
  `scripts/e2e-ficha-lead.mjs`. Alternativa: el bot sigue pudiendo pisar y solo
  el agente in-process respeta el candado.
- **Decisión abierta (dueño)**: datos de ficha **anteriores** a esta tarea (sin
  procedencia): ¿protegidos como humanos (propuesta, conservador) o libres para
  el agente?
- **Decisión abierta (dueño)**: ¿el **Vendedor** puede agregar claves libres
  fuera de la definición, o solo llenar los campos definidos? (Propuesta: sí,
  como hoy.)
- **Decisión abierta (dueño)**: ¿la plantilla se aplica automáticamente en ESTA
  instancia (agencia de autos) al desplegar, o el Propietario la aplica con el
  botón? (Propuesta: botón; Vocero es genérico.)
- **Decisión abierta (dueño)**: ¿`update_lead` (notas) se mantiene? Con la
  ficha, la nota libre pierde peso; propuesta: mantenerla para lo que no cabe en
  campos, y agregarle también `ficha` (ya cubierto por `withFicha`).
- **D-04-1 · Decisión tomada aquí (revisable)**: `ficha` como campo acompañante de
  cualquier acción en vez de una acción `update_ficha` propia, porque el
  contrato es UNA acción por turno y una acción aparte le robaría la respuesta
  al cliente. `update_ficha` se tolera como alias.

## Contrato 04-0 (fijado — servidor y UI trabajan contra esto)

Fijado antes de partir el trabajo en servidor y UI. Fuente de verdad en
código: `src/lib/ficha-fields.ts` (definición, procedencia, coerción) y
`src/lib/types.ts` (DTOs). Si algo de aquí cambia, se cambia en los tres
lugares en el mismo commit.

**Decisiones aplicadas** (README, 2026-10-12): D-04-1 `ficha` como campo
acompañante de toda acción + alias `update_ficha`; D-04-4 el cerebro externo
respeta el candado humano; legado sin meta protegido **solo contra `ia`**
(el `bot` sigue escribiendo sus claves legadas); el Vendedor puede agregar
claves libres; la plantilla se aplica con botón (no automática);
`update_lead` se conserva y también acepta `ficha`.

### Datos

- Migración `drizzle/0014_ficha_campos.sql` (no 0013: la tomó 00). Aditiva,
  nullable, re-ejecutable: `agent_profile.ficha_fields`, `contact.ficha_meta`,
  `agent_test_case.ficha_check`, tabla `ficha_event` (+ índice
  `ficha_event_org_contact_idx (organization_id, contact_id, created_at)`).
  `ficha_event` tiene FKs: `organization` y `contact` en cascade,
  `conversation` y `actor_user_id → user` en set null. Ids `fe_…`.
- `FichaFieldDef = { key, label, type: "texto"|"numero"|"si_no"|"opcion", options?, allowOther?, hint?, agentFills }`;
  validación `fichaFieldsSchema` (máx. 25, clave `^[a-z][a-z0-9_]*$` ≤ 60
  única, label ≤ 60, hint ≤ 200, `opcion` con 2–20 opciones únicas ≤ 60). El
  esquema devuelve la forma canónica: `options`/`allowOther` solo en `opcion`;
  `hint` vacío se omite.
- `contact.ficha_meta: { [key]: { by: "ia"|"humano"|"bot", at: ISO, userId? } }`.
  **No hay bandera `locked` ni valor `legado`**: candado = `by === "humano"`
  (`isFichaLocked`); legado = clave con valor y sin entrada de meta.
- Regla de escritura (`fichaWriteBlocked(source, entry, hasValue)`):

  | escribe | meta `humano` | con valor y sin meta (legado) | meta `ia`/`bot` o sin valor |
  |---|---|---|---|
  | `humano` | escribe | escribe | escribe |
  | `bot` | ignorado (`candado_humano`) | escribe | escribe |
  | `ia` | ignorado (`candado_humano`) | ignorado (`candado_humano`) | escribe |

- `ficha_event.outcome ∈ aplicado | ignorado_humano | invalido`;
  `reason ∈ candado_humano | clave_desconocida | no_la_llena_el_agente | tipo | opcion | tope`
  (NULL si se aplicó). `candado_humano` ↔ `ignorado_humano`; el resto ↔
  `invalido`. Nunca lleva el valor.
- Coerción (`coerceFichaPatch(raw, fields)`) SOLO para `source:"ia"`. El
  agente no borra: `null`/`""` se ignoran sin evento. Humano y bot conservan
  `null` = borrar.
- `agent_test_case.ficha_check: FichaCheck = { esperados: string[], llenados, cumplidos: string[] }`.

### HTTP

Errores con la forma de siempre `{ error: { code, message } }`. Comunes con
sesión: `401 unauthorized` sin sesión; `403 forbidden` ("Solo el Propietario
puede hacer esto") en rutas `owner`; `422 invalid_body` con detalle
`ruta: mensaje; …` (de `parseBody`).

**`GET /api/agent/ficha-fields`** — `owner` (stub 501 hoy).
- 200 `FichaFieldsResponse = { fields: FichaFieldDef[] | null }`.
- 404 `not_found` si no hay `agent_profile`.

**`PUT /api/agent/ficha-fields`** — `owner` (stub 501 hoy).
- Cuerpo `FichaFieldsPutBody = { fields: FichaFieldDef[] | null }`, validado
  con `fichaFieldsSchema` (estricto: es input humano). `[]` se guarda como
  `NULL` (= sin definición).
- 200 `{ fields }` canónico tal como quedó (`null` si se vació).
- 422 `invalid_body` (p. ej. `fields.2.key: clave repetida: ciudad`).
- 404 `not_found` si no hay `agent_profile`.
- No convierte ni borra valores guardados (renombrar/borrar un campo deja sus
  valores como claves libres).

**`GET /api/contacts/[id]`** — `any` (existe; se extiende, aditivo).
- 200 `ContactDetailResponse = { contact, stage, lead, fichaFields }`:
  `contact.ficha` (como hoy, `{}` si vacía) + `contact.fichaMeta`
  (`FichaMeta`, `{}` si NULL) y `fichaFields: FichaFieldDef[] | null` (la
  definición, para que el Vendedor pinte el panel sin ver `/agent`).
- 404 `not_found`.

**`PATCH /api/contacts/[id]`** — `any` (existe; se extiende, aditivo).
- Cuerpo `ContactPatchBody`: lo de hoy + `ficha?: Record<string, escalar|null>`
  (parche; `null` borra) y `fichaUnlock?: string[]` (máx. 40 claves).
- `ficha` pasa por `upsertFicha({ source:"humano", userId: session.userId })`:
  cada clave escrita queda `by:"humano"` (candado); borrar una clave elimina
  también su meta (el campo vuelve a estar libre para el agente).
- `fichaUnlock`: por clave con valor, `by` pasa a `"ia"` y el valor se queda
  (RF-04-08). Aplica a claves con candado (`by:"humano"`) y a las legadas
  (con valor y sin meta); claves sin valor o ya `ia`/`bot`: no-op. No genera
  evento (el valor no cambia). Si el mismo cuerpo trae
  `ficha` y `fichaUnlock` para la misma clave, se aplica primero `ficha` y
  después el desbloqueo.
- 200 `{ contact }` con `ficha` y `fichaMeta` actualizados.
- 404 `not_found` · 422 `invalid_body`.

**`GET /api/contacts/[id]/ficha/history`** — `any` (nuevo, stub 501 hoy).
- 200 `FichaHistoryResponse = { events: FichaEventDto[] }`: últimos 50 por
  `created_at` descendente, vía `scoped()`. `FichaEventDto = { id, key,
  oldValue, newValue, source, outcome, reason, actor: { id, name } | null,
  conversationId, createdAt }`.
- 404 `not_found` si el contacto no es de la organización.

**`PUT /api/bot/ficha`** — `bot` (existe; cambia a propósito por D-04-4).
- Cuerpo igual que hoy (`{ conversationId, ficha }`, claves libres, sin
  coerción por tipo).
- 200 `BotFichaResponse = { ficha, ignored: [{ key, reason }] }`: `ficha`
  completa resultante (como hoy) + `ignored` (aditivo; `[]` si nada). Las
  claves con candado humano no se escriben (`reason: "candado_humano"`); si no
  caben por el tope de 40, `reason: "tope"`. Lo escrito queda `by:"bot"`.
- 401 `unauthorized` · 404 `not_found` · 409 `no_org` · 422 `invalid_body`
  (sin cambios).

**`GET /api/bot/context`** — `bot` (existe; aditivo, RF-04-14).
- `contact.fichaMeta: FichaMeta` (`{}` si NULL) y `fichaFields:
  FichaFieldDef[] | null` en la raíz del payload.

### Permisos (`src/lib/permissions.ts`)

`GET`/`PUT /api/agent/ficha-fields` → `owner`;
`GET /api/contacts/[id]/ficha/history` → `any`. Las demás no cambian de
política. Los stubs ya llevan su guarda definitiva (`role-matrix` verde).

## 3. Dependencias con otras tareas

- **03 — Contexto del contacto** (prerrequisito): el agente necesita ver la
  ficha actual (y qué campos están "confirmados por el equipo") para no
  repetir, no preguntar de nuevo y no intentar pisar; 03 también trae
  `resetTestContact` y el reinicio del contacto sintético del Laboratorio, que aquí
  se extiende a `ficha_meta` y eventos.
- **00 — Roles y permisos** (prerrequisito): guard de Propietario para
  `/api/agent/ficha-fields`; el Vendedor no ve `/agent`, por eso la definición
  de campos le llega por `GET /api/contacts/[id]`.
- **09 — Asignación**: la visibilidad de contactos por vendedor aplica a
  `/api/contacts/[id]/ficha/history`; `actor_user_id` permite saber qué
  vendedor corrigió.
- **02 — Métricas del agente**: consume `ficha_event` (tasa de llenado por
  campo, % corregido por humanos = precisión del agente).
- **08 — Laboratorio por cliente**: reutiliza `expectFicha` por persona.
- **Migraciones**: coordinar el número (0013) con 00/09 si alguna también
  migra; se asigna al generar, no a mano.
