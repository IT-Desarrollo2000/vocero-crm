# US — Agenda por IA robusta: día pedido, reservar por clave local, trato (025)

Spec: [specs/025-agenda-ia-robusta/spec.md](../../specs/025-agenda-ia-robusta/spec.md)
(la sección "Ajustes tras la revisión del asesor" del plan manda). Sale del
incidente del 21-oct: el agente inventó "viernes 24, 10:00/10:30/11:00" (el
viernes era 23), el cliente eligió "11", la reserva falló y se le re-ofreció lo
ya rechazado, tuteando.

Automatizado: bloque `025)` de `scripts/e2e-agenda-presencial.mjs` (agente
real por WhatsApp y Messenger, trato usted) + modo `--off`. NO está encadenado
en `pnpm test:e2e`. BD aislada `vocero_023` (:5433), puerto 3103, recién
migrada (0026) y con el server reiniciado antes de cada guion:

```bash
CATALOG_STORAGE=local AGENDA_REMINDER_TICK_MS=0 node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103 > server.log 2>&1
E2E_SERVER_LOG=server.log node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs

AGENDA=off CATALOG_STORAGE=local node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103
AGENDA=off node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs --off
```

`E2E_SERVER_LOG` (opcional) es la ruta del log del server: con ella el guion
comprueba que la barrera se registró.

## El modelo simulado NO recibe el ISO (CA-7)
El ai-mock (`src/server/dev/ai-mock.ts`, solo tras `mockGuard`) responde a
marcadores que lo obligan a leer el prompt como un modelo real:
- `[e2e-dia <viernes|YYYY-MM-DD> <tipo>]` → `offer_slots` con `date`, que el
  mock saca de la línea `Próximos días: … vie 23=2026-10-23 …` (no la calcula).
- `[e2e-elige <HH:MM|H>]` → `book_slot` con `slot` = la clave de HORARIOS
  OFRECIDOS marcada con `*` a esa hora (si no, cualquiera a esa hora; si
  ninguna, una clave inexistente del mismo día).
- `[e2e-elige-con-precio <HH:MM|H>]` → igual, más `reply` "El Macaron 2P
  cuesta $285,990.".
- `[e2e-inventa]` → el `reply` con horarios inventados del incidente.
- `[e2e-horario-atencion]` → "Abrimos de lunes a sábado de 9:00 a 18:00 y
  domingo de 10:00 a 15:00." (falso positivo: debe salir tal cual).
Los marcadores leen TODOS los mensajes del cliente desde la última respuesta
del agente (el coalescido junta varios). El guion tampoco lee `offered_slot`
para elegir: solo para verificar.

## Preparación (Propietario)
Agente → **Trato con el cliente: Usted** (`PUT /api/agent/profile` con
`formality`; el Vendedor recibe 403). Ajustes → Agenda con dirección.

## Guion (WhatsApp y Messenger)
1. **a)** El cliente pide una prueba de manejo → "Tengo estos horarios
   disponibles para su prueba de manejo:" con 3 horarios + "Si prefiere otro
   día, dígame cuál." El saliente guarda `agent_action` (`offer_slots` con lo
   mostrado).
2. **b) CA-1** "¿Y el viernes?" → "Para el viernes 23 de octubre tengo estos
   horarios para su prueba de manejo:" con horarios REALES de ese viernes
   (los de `GET /api/calendar/availability`). Nunca "24".
3. **c) CA-2** Responde una hora suelta que vio ("11", "7:30") → "¡Listo! Le
   agendé su prueba de manejo para vie 23 oct, 07:30. Le esperamos en
   {dirección}." La cita queda el viernes a esa hora local, de la IA.
4. **d) CA-3** En otra conversación, tras una oferta, pide una hora que no se
   ofreció (23:45) → "Ese horario no lo tengo disponible." + horarios del MISMO
   día que no había visto. Sin cita.
5. **e) CA-4** El modelo escribe a mano "viernes, 24 de octubre a las 10:00 •
   10:30 • 11:00" → eso NO sale; sale la oferta real del motor para el viernes
   23 (`offered_slot` con filas de ese día) y el log dice `[agente] barrera de
   horarios`. Un horario de atención ("Abrimos de lunes a sábado…") sí sale tal
   cual.
6. **B1** Elige una hora y pregunta el precio en el mismo mensaje → "El
   Macaron 2P cuesta $285,990.\n¡Listo! Le agendé su servicio para …" (el
   precio primero; `agent_action.reply` lo guarda para el historial).
7. **g) Coalescido** "15" (o la hora que vio) y "¿y cuánto cuesta?" casi
   juntos → UNA cita a esa hora. Con `AGENT_COALESCE_MS=300` y ~0,6 s entre
   los dos, se observó un solo turno del agente.
8. **f) CA-5** Con usted, ningún texto del motor (oferta, re-oferta,
   confirmación, pregunta de tipo "¿Qué tipo de cita le interesa?", "Se me
   acaba de ocupar ese horario, ¡disculpe!") tutea. Con tú: "Si prefieres otro
   día, dime cuál." y "Te agendé … Te esperamos en …".
9. **j) Laboratorio** Una persona con guion `[e2e-agenda Servicio]` → el
   saliente de agenda en la conversación `is_test` guarda `agent_action`.

## CA-6 — Bandera apagada
`--off`: todo lo de agenda responde 404 y la migración 0026 está aplicada
(`agent_profile.formality` NOT NULL default `'tu'`, `message.agent_action`).
Que el prompt y las acciones no mencionen la agenda lo cubren los unit
(`tests/unit/agenda-barrier-pipeline.test.ts`).

## Camino infeliz
- Hora no ofrecida / ocupada al confirmar → re-oferta del día, nunca una cita
  no ofrecida.
- Si la barrera pidió la oferta y el motor falla → "Permítame revisar los
  horarios disponibles con el equipo y le confirmo." (no silencio).
- Falsos positivos que NO disparan la barrera: horario de atención (abre/
  cierra, atendemos, lunes a…), rangos, precios, "Quedan las 3 unidades
  blancas y las 2 negras", "Su cita queda a las 11:00; llegue a las 10:45…".
