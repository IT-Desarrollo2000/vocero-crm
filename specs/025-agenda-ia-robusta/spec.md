# 025 — Agenda por IA robusta (día pedido, reservar por opción, trato)

**Carril**: ciclo completo. Corrige la agenda del agente de IA (015/023, detrás
de `AGENDA`, ENCENDIDA en producción desde el 20-oct). Migración 0026.

## Problema (incidente real, 21-oct-2026, conversación cv_vzkn7hcu2mb9w58gkjk0)

Un cliente pidió una visita, rechazó los 3 horarios de hoy y pidió "el
viernes". El agente **inventó** "viernes 24, 10:00/10:30/11:00" (el 24 es
sábado). El cliente eligió "11", la reserva falló (nunca se ofreció) y el
sistema re-mandó los horarios de hoy ya rechazados, tuteando. Después un "15"
(15:00 de hoy, válido) se ignoró. Cero citas.

Causas verificadas en código y en la BD de producción:
1. `offer_slots` no acepta día: registra 12 horarios (3 por día, 4 días; el
   viernes 23 SÍ estaba registrado) pero solo **muestra** los 3 primeros. El
   modelo no puede ver ni pedir los de otro día.
2. Para reservar, el modelo debe escribir el instante exacto en ISO UTC; las
   ofertas (con su ISO) **nunca** llegan al prompt. Solo ve "mié 21 oct a las
   15:00". Convertir a UTC a ojo es frágil.
3. Tras `slot_not_offered` se re-ofrecen los 3 primeros (los ya rechazados).
4. La fecha actual solo está dentro del bloque de contacto ("miércoles,
   21/10/2026, 12:24"; puede faltar si ese bloque falla) y sin calendario: el
   modelo calculó mal la fecha del viernes.
5. El historial le presenta sus ofertas pasadas como `reply` con horas →
   aprende a escribir horarios a mano. No hay barrera de código.
6. Los textos del motor de agenda tutean; el negocio habla de usted.
7. El modelo dijo "le paso con un asesor" mientras él agendaba (la KB dice
   "se agenda con un asesor") e ignoró la pregunta del precio y el "15".

## Decisiones del dueño (21-oct)
- Implementar todo (puntos 1–6 + ajustes de agenda) y desplegar al terminar.
- Mientras tanto, la agenda se queda como está (encendida).
- Trato **configurable** (tú/usted) en el perfil del agente; esta instancia
  en **usted**.
- Ajustes → Agenda en producción con los datos de la KB: dirección "Blvd.
  Adolfo Ruiz Cortines 915, Centro, Villahermosa, Tabasco"; horario L–S
  9:00–18:00 y domingo 10:00–15:00.

## Historias

### US-1 — Pedir un día y franja
- `offer_slots` acepta `date` (`YYYY-MM-DD`) y `part` (`mañana` | `tarde`).
- Con `date`: se registran TODOS los huecos reales de ese día (y franja), y se
  muestran hasta 4 repartidos en el día. Sin huecos ese día → el día más
  cercano posterior, diciéndolo ("Ese día ya no tengo; el más cercano es…").
- Sin `date`: como hoy (catálogo de varios días), y el mensaje invita a pedir
  otro día.

### US-2 — Reservar sin adivinar el instante
- El prompt (agenda encendida) incluye **HORARIOS OFRECIDOS** vigentes de la
  conversación con su clave en hora local (`2026-10-23 11:00 (vie)`), el tipo
  y una marca en los que el cliente vio.
- `book_slot` acepta `slot` (esa clave local) además de `startUtc`. El
  modelo traduce "11", "la de las 10", "la primera" a una clave. Sin números
  de opción (un "15" no debe confundirse con la opción 15).
- Una clave no ofrecida → re-oferta útil (US-3); nunca se agenda algo no
  ofrecido.

### US-3 — Re-oferta útil
- Si la hora pedida no se ofreció: se ofrecen los huecos reales del **día
  pedido** (si se puede deducir) y si no, horarios de otros días que **no se
  hayan mostrado** — nunca repetir los mismos 3.

### US-4 — Fecha sin ambigüedad
- Con agenda encendida el prompt dice "Hoy es miércoles 21 de octubre de
  2026, 12:24 (zona)" y un calendario de los próximos 14 días
  (`vie 23 oct = 2026-10-23`), independiente del bloque de contacto.

### US-5 — Sin horarios inventados
- El historial muestra los mensajes de agenda del motor como la ACCIÓN que
  los produjo (`offer_slots` / `book_slot`), no como `reply` con horas.
- Barrera: si un `reply` (o la intro/despedida de otra acción) trae una lista
  de horarios escrita por el modelo, se convierte en `offer_slots` (con el día
  deducido si nombra uno). Conservadora: un horario de atención suelto o una
  hora que repite el cliente no la dispara. Se registra en log.
- Reglas del prompt de agenda: si tú agendas no digas que pasas con un asesor;
  responde también las otras preguntas del mensaje; un número suelto tras ver
  horarios es la hora elegida.

### US-6 — Trato tú/usted
- Perfil del agente → "Trato con el cliente: Tú / Usted" (default Tú).
- Todos los textos del motor de agenda y los respaldos de recordatorios
  respetan el trato. La pregunta de tipo se reconoce en ambas variantes.
- El prompt incluye la regla de trato.

## Criterios de aceptación
- CA-1: "¿qué tal el viernes?" → horarios reales del viernes (o el día más
  cercano), nunca inventados.
- CA-2: con ofertas vigentes, "11" → `book_slot` por opción → cita creada a
  las 11:00 del día ofrecido.
- CA-3: opción/hora no ofrecida → re-oferta del día pedido o de horarios no
  mostrados; sin cita.
- CA-4: un `reply` con lista de horarios inventada no se envía tal cual: sale
  una oferta real.
- CA-5: con trato usted, ningún texto del motor tutea.
- CA-6: con `AGENDA` apagada, nada de esto aparece en el prompt ni en las
  acciones.
- CA-7: el E2E simula al modelo SIN darle el ISO (elige por opción/día
  leyendo el prompt), para no repetir el punto ciego de la 023.
