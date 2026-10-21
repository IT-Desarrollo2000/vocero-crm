# 025 — plan

Spec: [spec.md](spec.md). Rama `025-agenda-ia-robusta` (worktree
`vocero-crm-023`) desde origin/main e566edf. Migración **0026**.

## Datos (migración 0026, re-ejecutable)
- `agent_profile.formality` text NOT NULL default `'tu'` (`'tu' | 'usted'`).
- `message.agent_action` jsonb NULL: la acción de agenda que produjo un
  saliente del motor (`{action:"offer_slots", type, date, part, reply}` o
  `{action:"book_slot"}`). Solo la escribe el pipeline del agente.

## Motor (`src/server/agenda/`)
- `copy.ts` (nuevo): diccionario de textos del motor por trato
  (`tu` / `usted`), incluida la pregunta de tipo; `isTypeQuestion` reconoce
  ambas variantes (y la vieja).
- `agent.ts`:
  - `offerSlots({ typeName, date?, part?, formality })`:
    - con `date`: `computeAvailability` del día (strict, duración del tipo),
      filtro por franja (mañana < 12:00 ≤ tarde, hora local); registra todos
      los del día (tope 24) con `replaceOffers`; muestra hasta 4 repartidos
      uniformemente. Sin huecos → busca el primer día posterior con huecos
      (hasta `maxDaysAhead`) y lo dice.
    - sin `date`: como hoy + línea "Si prefiere otro día, dígame cuál."
  - `bookSlot({ option?, startUtc?, formality })`: `option` → ofertas
    vigentes ordenadas (mismo orden que el bloque del prompt) → `startUtc`.
  - re-oferta en `slot_not_offered` / opción inválida: si el instante pedido
    se puede fechar → `offerSlots({date})`; si no → ofertas vigentes que no se
    hayan mostrado (primer hueco de cada día).
- `offers.ts`: `formatOffersForPrompt(offers, tz)` → líneas numeradas
  `1) mié 21 oct 14:30 — Prueba de manejo`.

## Agente (`src/server/ai/`)
- `actions.ts`: `offer_slots` + `date?` (YYYY-MM-DD tolerante), `part?`;
  `book_slot` + `option?` (número o string numérico), `startUtc?` opcional;
  sin ninguno → degradar a re-oferta.
- `prompts.ts` (`buildAgentSystemPrompt`, solo con agenda):
  - "Hoy es {día semana} {d} de {mes} de {año}, {hh:mm} ({tz})" + calendario
    de 14 días;
  - bloque **HORARIOS OFRECIDOS** numerado (o "ninguno");
  - reglas: usar `date` cuando el cliente nombra un día; reservar con
    `option`; número suelto tras ver horarios = la hora; si tú agendas no
    digas que pasas con un asesor; responde también las otras preguntas.
  - regla de trato según `formality` (siempre, no solo agenda).
- `pipeline.ts`: carga `getOffers` y `formality`; pasa `date/part/option`;
  persiste `agent_action` en el saliente del motor; **barrera de horarios**
  en `reply`/intro/despedida (función pura `detectInventedSlots(text)`:
  ≥2 horas `HH:MM`/`a las N` + viñetas o nombre de día → convierte a
  `offer_slots` con el día deducido y el tipo de la oferta vigente; log
  `[agente] barrera de horarios`).
- `history.ts`: salientes con `agent_action` se representan como esa acción
  JSON (no como `reply` con horas).

## Perfil y recordatorios
- API/UI del perfil del agente: campo `formality` (select Tú/Usted).
- `src/lib/reminders.ts`: respaldos según trato.

## Pruebas
- Unit: copy (sin "te/tu" en usted), offerSlots con date/part/fallback,
  bookSlot por option, re-oferta sin repetir, formatOffersForPrompt,
  prompt (fecha + calendario + ofertas + trato), actions tolerantes,
  history con agent_action, detectInventedSlots (positivos y falsos
  positivos: horario de atención de la KB, precios, hora repetida).
- ai-mock: marcadores que NO dan el ISO: `[e2e-dia <YYYY-MM-DD|viernes> <tipo>]`
  → offer_slots con date; `[e2e-elige HH:MM]` → lee HORARIOS OFRECIDOS del
  system prompt y responde book_slot con esa `option`; `[e2e-inventa]` →
  reply con lista de horas inventadas.
- E2E `scripts/e2e-agenda-presencial.mjs` (+ selftest) con CA-1…CA-7, BD
  `vocero_023`, puerto 3103.

## Ajustes tras la revisión del asesor (21-oct) — MANDAN sobre lo anterior

- **A1 (reservar sin números)**: NO hay `option` numerada (un "15" del
  cliente se confundiría con la opción 15). El bloque **HORARIOS OFRECIDOS**
  lista cada oferta vigente con su clave en hora LOCAL del negocio:
  `2026-10-23 11:00 (vie) — Servicio`, marcando con `*` las que el cliente
  VIO en el último mensaje. `book_slot` acepta `slot: "YYYY-MM-DD HH:MM"`
  (hora local; se convierte con la zona del negocio y se compara contra las
  ofertas por epoch) además de `startUtc`. Reglas: una hora suelta del
  cliente ("11", "15", "10:30") es del día de los horarios que acaba de ver;
  si no coincide con ninguna oferta → `offer_slots` con ese día.
- **A2 (array en memoria)**: `bookSlot` resuelve contra el MISMO array de
  ofertas que armó el prompt (cargado una vez en el turno); sin ordinal en BD.
- **A3 (ventana)**: `date` se acota a `[hoy, hoy+maxDaysAhead]` en la zona
  del negocio; fuera de rango o pasado → "sin huecos ese día" → día válido más
  cercano, diciéndolo. El filtro de franja usa la hora local (`timeInTz`).
- **A4 (barrera segura)**: corre DESPUÉS de `degradeAction`. Al convertir a
  `offer_slots` la intro es la del MOTOR (nunca el texto del modelo). Sin tipo
  resoluble (varios tipos, sin oferta vigente) → pregunta de tipo del motor.
  Detección conservadora: POSITIVO solo si ≥2 horas (al menos una `HH:MM` o
  tras "a las/las") separadas por viñeta/salto/coma/" y " **y** léxico de
  oferta en la misma línea o mensaje (`disponible|tengo|puedo ofrecer|
  horarios|opciones|quedan|le acomoda|te acomoda`) **y no** rango (`de X a Y`,
  `X a Y`, `entre X y Y`, `X-Y`) **y no** léxico de atención (`abrimos|
  cerramos|atendemos|horario de atención|lunes a`). Día deducido: el NOMBRE
  del día manda sobre el número. Log `[agente] barrera de horarios` con el
  texto descartado.
- **A5 (Laboratorio)**: `agent_action` se escribe en `persistOutbound`
  (vía `sendText`) **y** en `persistTestOutbound` del pipeline.
- **A6 (historial con contexto)**: `{"action":"offer_slots","type":…,
  "date":…,"shown":["vie 23 oct 10:00",…]}` y
  `{"action":"book_slot","booked":"vie 23 oct 11:00"}`. Lo mostrado se guarda
  en `agent_action.shown` (de ahí sale el `*` del bloque y la re-oferta "no
  mostrados").
- **A7 (re-oferta en ambos errores)**: `slot_not_offered` y `slot_taken` en
  `bookSlot` re-ofrecen con el día deducido del instante pedido.
- **A8 (fecha)**: la fecha ya estaba en el bloque de contacto (puede faltar);
  se agrega fija en la sección de agenda: `Hoy: miércoles 21 oct 2026 12:24
  (America/Mexico_City)` + `Próximos días: jue 22=2026-10-22, …` (14 días).
- **A9 (trato en el Laboratorio)**: snapshot/`behaviorTextOf` del Lab
  incluyen "Trato: usted|tú" para que el juez no penalice.
- **A10 (prompt)**: regla "si hay varios mensajes nuevos del cliente,
  atiende todos".
- **A11 (prod)**: la fila de `calendar_settings` de prod existe y su forma es
  la normalizada (`{"mon":[{"start":"09:00","end":"18:00"}],…}`); el ajuste
  se hace con un UPDATE acotado a la org con esa misma forma (agregando
  `sat` y `sun`) + `address`, y se verifica después con `getSettings`. La
  entrada de KB "se agenda con un asesor" se le señala al dueño (no se edita
  sin su OK).
- `agenda_offer_log`: cada re-oferta por día cuenta como ronda (sesgo
  aceptado y documentado).

## Despliegue
- Merge FF + push + deploy (autorizado). Luego, en prod (SQL acotado a la
  org): `calendar_settings.address` y `weekly_hours` (L–S 09–18, D 10–15) y
  `agent_profile.formality='usted'`.
