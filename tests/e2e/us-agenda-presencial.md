# US — Agenda presencial: tipos de cita, vendedores y choques (023)

Spec: [specs/023-agenda-presencial/spec.md](../../specs/023-agenda-presencial/spec.md).
Todo detrás de `AGENDA` (apagada por defecto).

Automatizado: `scripts/e2e-agenda-presencial.mjs` (API + agente real con
el ai-mock) y `scripts/e2e-agenda-presencial-ui.mjs` (Playwright). NO están
encadenados en `pnpm test:e2e`. Con la app viva y los mocks (`.env.e2e`, BD
aislada `vocero_023` en :5433, puerto 3103), recién migrada y con el server
reiniciado ANTES DE CADA guion (el limitador de login es por IP y en
memoria):

```bash
# encendida (CHANNELS con instagram y messenger; reloj de recordatorios quieto)
CATALOG_STORAGE=local AGENDA_REMINDER_TICK_MS=0 node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103
node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs
E2E_SHOTS_DIR=<carpeta> node --env-file=.env.e2e scripts/e2e-agenda-presencial-ui.mjs

# apagada (la bandera en el server Y en el guion)
AGENDA=off CATALOG_STORAGE=local node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103
AGENDA=off node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs --off
```

El agente in-process se conduce con dos marcadores del ai-mock
(`src/server/dev/ai-mock.ts`, solo tras `mockGuard`): `[e2e-agenda <tipo>]`
→ `offer_slots` con `type`, y `[e2e-reserva <ISO>]` → `book_slot` (el ISO se
toma de la oferta registrada en `offered_slot`).

El bloque de agenda de `scripts/e2e-selftest.mjs` cubre además la bandera
(`/api/calendar/types` en la lista de 404) y el hueco reservado por tipo.

## Preparación (Propietario)
1. Ajustes → Agenda: horario abierto, "Cada cuánto empieza un horario" 30 min,
   sin margen, sin anticipación mínima.
2. Tarjeta **Tipos de cita**: aparece la siembra — Prueba de manejo
   (exclusiva, 60 min), Servicio (30), Garantía (30), Otro (30).
3. Equipo: da de alta a dos Vendedores (Juan y Ana).

## CA-1 — Dos vendedores, Servicio a la misma hora
1. Juan → Citas → **Nueva cita**: contacto, Servicio, mañana 10:00 → Guardar.
2. Ana → Nueva cita, Servicio, mañana: el 10:00 aparece **Ocupado** con
   "(Servicio, con Juan)". Lo elige → "A esa hora ya hay 1 cita (Servicio, con
   Juan). ¿Agendar de todos modos?" (409 `overlap_warning` con `conflicts`;
   todavía no se creó nada).
3. Confirma → se crea (201). En Citas (Propietario) hay dos citas a las 10:00,
   una de Juan y otra de Ana, cada una con su tipo y 30 min.

## CA-2 — Una sola Prueba de manejo a la vez
1. Propietario agenda Prueba de manejo mañana 12:00 para Juan.
2. Ana (o el Propietario, para Ana o sin vendedor) intenta Prueba de manejo a
   las 12:00, 12:30 u 11:30 → rechazo `slot_taken` aunque confirme. El horario
   no aparece en la rejilla de ese tipo.
3. Un Servicio a las 12:00 → solo la advertencia. Una Prueba de manejo a las
   13:00 (contigua, sin traslape) → se crea.

## CA-3 — El mismo vendedor no se traslapa; reasignar
1. Juan tiene Servicio a las 16:00. Otra cita suya a las 16:00 (Garantía, aun
   confirmando) o una Prueba de manejo a las 15:30 → `slot_taken`.
2. El Propietario agenda a Ana a las 16:00 (confirmando) y luego **Reasignar**
   → Juan: 409 `slot_taken` con la cita que choca. Reasignar a alguien libre →
   200. Un usuario que no es miembro → 422.
3. Un Vendedor que manda `assignedUserId` (aunque sea `null`) → 403; un
   Vendedor no reasigna (403).

## CA-4 — El agente / bot no pisa ninguna cita
1. El bot (`GET /api/bot/availability?type=Servicio`) ofrece horarios. Un
   humano agenda el primero → el bot ya no lo ofrece, ni ningún horario que
   traslape una cita activa de cualquier tipo o vendedor. `type` acepta id o
   nombre normalizado ("prueba de manejo").
2. Dos conversaciones con el mismo horario ofrecido reservan a la vez
   (`POST /api/bot/bookings` ×2 en paralelo) → un 201 y un 409 `slot_taken`
   con alternativas; queda UNA cita activa, de la IA y sin vendedor.

## CA-5 — Visibilidad por vendedor
1. Ana ve: sus citas, las sin asignar, los bloqueos y las que ella creó
   aunque el Propietario se las haya pasado a Juan (A3).
2. Ana NO ve las de Juan; cancelar o reprogramar una de ellas (o pedir su
   rejilla con `excludeBookingId`) → 404, y la cita sigue intacta.
3. La respuesta de Ana no trae `sellers`; la del Propietario sí, y sus
   filtros por vendedor, "sin asignar" y tipo funcionan.

## CA-6 — Bandera apagada
Con `AGENDA=off`: `/api/calendar/types` (GET/POST/PATCH), availability,
settings, `/api/bookings` (GET/POST/PATCH), `/api/bot/availability` y
`/api/bot/bookings` → 404, y la pantalla `/bookings` no existe. La migración
0025 está aplicada igual (tabla `appointment_type` y columnas nuevas).

## CA-7 — Laboratorio
Una cita en una conversación del Laboratorio (`is_test`) no ocupa la agenda:
el horario sigue libre en la rejilla y una cita real del mismo tipo exclusivo
y del mismo vendedor a esa hora se crea directo. (Que no toque conectores ni
recordatorios: `tests/unit/agenda-sandbox.test.ts` y
`scripts/e2e-recordatorios.mjs`.)

## CA-8 — Messenger e Instagram
1. Propietario guarda la **Dirección del negocio** (se recorta; vacía → sin
   dirección; >300 caracteres → 422). El Vendedor no puede cambiarla (403).
2. Agente encendido. El cliente escribe por Messenger (conversación asignada
   a Juan) o Instagram (sin asignar) y pide un servicio → el agente responde
   por el canal "Tengo estos horarios disponibles para tu servicio:" con tres
   horarios. Elige uno → "¡Listo! Te agendé tu servicio para … Te esperamos en
   {dirección}." (sin enlace). La cita queda de la IA, tipo Servicio, con
   vendedor = el asignado de la conversación (Juan) o sin vendedor.
3. Con recordatorios encendidos, esa cita no programa ni envía recordatorio
   (lista vacía o `skipped`); una cita de WhatsApp en la misma vuelta sí.
4. Camino infeliz con el agente: un tipo que no existe → "¿Qué tipo de cita te
   interesa? Tengo: Prueba de manejo, Servicio, Garantía u Otro."; un horario
   que no se ofreció → "Déjame confirmarte los horarios que tengo:" sin crear
   cita; nunca ofrece un horario con una cita manual de otro tipo.

## UI (Playwright: `scripts/e2e-agenda-presencial-ui.mjs`)
- Ajustes → Agenda: siembra visible; alta de "Entrega" (45 min); Garantía a
  40; dirección; persiste al recargar; sin "Cómo se entrega la reunión" ni
  "Tu sala de siempre".
- Citas → Nueva cita (buscador de contacto, tipo, día, horario) → aviso y
  fila con tipo y vendedor.
- Vendedor en la Bandeja → Agendar: el mismo horario sale "Ocupado" con el
  detalle; Guardar → "Horario ocupado" → "Agendar de todos modos".
- Con una Prueba de manejo agendada, ese horario y sus traslapes no salen en
  la rejilla de Prueba de manejo.
- Filtros por vendedor y tipo; Reasignar a alguien ocupado → "Ese vendedor ya
  tiene una cita a esa hora"; a alguien libre → "Cita reasignada.".
- La Vendedora no ve la cita de Juan; "Mías" filtra.
- Reprogramar con el diálogo → hora nueva en la fila.
- Falla de red al guardar → error visible en el diálogo; reintento → se crea.
- Móvil 390×844: el diálogo funciona y la página no tiene scroll lateral.

## Camino infeliz
- `typeId` inexistente o desactivado → 422; sesión sin `typeId` → 422.
- Rejilla con `typeId` inexistente → 422.
- Bot con `type` desconocido → 422 `unknown_type` con `types` como hermano.
- Dirección de 301 caracteres → 422 (300 se acepta).
- Tipo con duración fuera de 10–480 → 422.
- Un tipo desactivado deja de listarse (sigue en `?all=1`, solo Propietario).
