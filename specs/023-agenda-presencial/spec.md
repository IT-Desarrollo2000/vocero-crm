# 023 — Agenda presencial (tipos de cita, vendedores y choques)

**Carril**: ciclo completo (Principio VI). Extiende la agenda de la 015 (detrás
de la bandera `AGENDA`, apagada en producción). Toca el modelo de datos
(migración 0025), el motor de disponibilidad, el agente, la API del bot,
Ajustes → Agenda, la pantalla Citas y la Bandeja. Sin terceros nuevos.

## Problema

La agenda de la 015 se diseñó para **sesiones remotas de un solo calendario**:
una cita a la vez en todo el negocio (índice único `(org, scheduled_at)`),
todas con la misma duración, sin vendedor, sin tipo y con textos de "enlace de
la reunión". La agencia de autos la necesita para **visitas físicas** (prueba
de manejo, servicio, garantía) que agendan **varios vendedores a la vez**:

1. Dos vendedores distintos SÍ pueden citar a la misma hora (cada quien atiende
   a su cliente), pero deben enterarse de que ese horario ya está ocupado.
2. Hay citas que usan un recurso compartido (el auto demo): dos **pruebas de
   manejo** no pueden coincidir aunque las agenden vendedores distintos.
3. El agente de IA agenda solo, sin un humano que lea la advertencia: no debe
   pisar ninguna cita.
4. Messenger e Instagram ya llegan a la Bandeja y el agente ya agenda en ellos;
   la agenda debe funcionar igual ahí (sin recordatorios en esos canales).

## Decisiones del dueño (20-oct-2026)

1. La exclusividad es por **tipo de cita** (solo una prueba de manejo a la vez
   en toda la agencia), no por auto.
2. **Catálogo de tipos** editable por el Propietario: nombre, **duración
   configurable** y "exclusivo sí/no". Siembra: Prueba de manejo (exclusiva,
   60 min), Servicio (30), Garantía (30), Otro (30).
3. **Vendedor de la cita**: el asignado a la conversación si se agenda desde el
   chat; si la conversación no tiene asignado, quien la crea; en el alta manual,
   quien la crea. El Propietario puede reasignar. Si la IA agenda en una
   conversación sin asignar, la cita queda sin vendedor.
4. Choques para **humanos**: con la cita de otro vendedor (tipo no exclusivo) →
   **advertencia** y confirmación explícita; con el mismo tipo exclusivo →
   **rechazo** con alternativas. El **agente de IA no agenda encima de ninguna
   cita activa**.
5. Un vendedor **no** puede tener dos citas suyas traslapadas (rechazo).
6. **Una sola dirección** por negocio, en la confirmación ("Te esperamos en …").
7. **Sin recordatorios por Instagram ni Messenger** (se conserva el `skipped`
   actual); no se pide el WhatsApp del cliente.
8. Zoom / Google Meet: **se conservan en el código, ocultos en la UI**.
9. Visibilidad: el Vendedor ve sus citas + las sin asignar; el Propietario ve
   todas; las advertencias consideran **todas** las citas.

## Historias

### US-1 — Tipos de cita (Propietario)
- Ajustes → Agenda tiene la tarjeta **Tipos de cita**: alta, edición (nombre,
  duración 10–480 min, exclusivo), orden y desactivar (no se borra: las citas
  viejas lo referencian).
- Una organización sin tipos recibe la siembra al primer uso (idempotente).
- Un tipo desactivado deja de ofrecerse; sus citas existentes no cambian.
- La duración de la cita se **copia** del tipo al crearla (cambiar el tipo no
  reescribe el pasado).

### US-2 — Dirección y modo presencial (Propietario)
- Ajustes → Agenda tiene el campo **Dirección del negocio** (opcional).
- La tarjeta "Cómo se entrega la reunión" y las credenciales de Zoom/Google
  **no se muestran**. El código y la API siguen ahí.
- "Duración de cada cita" pasa a ser "Cada cuánto empieza un horario" (rejilla);
  la duración real la da el tipo.

### US-3 — Agendar desde Citas y desde la Bandeja (Vendedor y Propietario)
- Botón **Nueva cita** en Citas: contacto (buscador), tipo, día y horario
  (rejilla del día), vendedor (solo el Propietario elige; el Vendedor queda
  como él mismo) y notas.
- Botón **Agendar** en la conversación de la Bandeja: el mismo formulario con
  contacto y conversación prellenados; el vendedor por defecto es el asignado
  a la conversación (o quien agenda, si no hay asignado).
- Los horarios **bloqueados de verdad** no aparecen: bloqueos manuales, el
  mismo tipo exclusivo ya ocupado y las citas del propio vendedor.
- Los horarios con **otra cita** aparecen marcados "Ocupado" con el detalle
  (tipo, vendedor). Elegirlo muestra la advertencia "A esa hora ya hay 1 cita
  (Servicio, con Juan). ¿Agendar de todos modos?"; solo con la confirmación se
  crea.
- Si en el instante de guardar otra persona ocupó el horario de forma
  incompatible, se rechaza con alternativas frescas; si apareció una cita
  compatible nueva, se vuelve a pedir confirmación.

### US-4 — Lista de citas por vendedor
- Cada cita muestra tipo, vendedor (o "Sin asignar") y duración (la dirección
  es única por negocio: va en la confirmación al cliente, no en cada fila).
- Filtros: vendedor (Propietario: todos / cada vendedor / sin asignar;
  Vendedor: mías / sin asignar / todas las que veo) y tipo.
- El Vendedor ve sus citas (asignadas a él o creadas por él), las sin asignar
  y los bloqueos. El Propietario ve
  todo y puede **reasignar** la cita a otro vendedor (con la misma regla:
  el nuevo vendedor no puede tener otra cita traslapada).
- Reprogramar usa las mismas reglas que agendar (advertencia/rechazo).

### US-5 — El agente de IA agenda visitas
- `offer_slots` lleva el **tipo** (nombre). Si falta o no existe, el sistema
  pregunta qué tipo de cita quiere, con los nombres reales del catálogo.
- El agente solo ofrece horarios donde **no hay ninguna cita activa** ni
  bloqueo (cualquier tipo, cualquier vendedor), con la duración del tipo.
- `book_slot` reserva el tipo que se ofreció (la oferta guarda el tipo).
- Confirmación: "¡Listo! Te agendé tu {tipo} para {fecha}. Te esperamos en
  {dirección}." (sin dirección configurada, sin esa frase).
- El vendedor de la cita es el asignado a la conversación (o ninguno).
- Funciona igual en WhatsApp, Messenger e Instagram. El prompt deja de decir
  "asistente de WhatsApp".

### US-6 — Bot externo
- `GET /api/bot/availability` acepta `type` (id o nombre) opcional; sin él usa
  el único tipo activo o, si hay varios, el primer tipo activo **no
  exclusivo**. Misma regla estricta que el agente.
- `POST /api/bot/bookings` reserva el tipo ofrecido; `PATCH` reprograma
  conservando el tipo. El contrato existente no se rompe.

## Fuera de alcance
- Recordatorios por Instagram/Messenger (bloqueo de política de Meta, ver
  plan §Recordatorios).
- Inventario de autos demo / recursos por unidad.
- Varias sucursales.
- Vista de calendario semanal (la lista con filtros basta por ahora).
- Que el agente reprograme o cancele (sigue el handoff de la 015).

## Criterios de aceptación
- CA-1: Dos vendedores agendan Servicio a la misma hora: el segundo recibe la
  advertencia y, al confirmar, ambas citas existen.
- CA-2: Una segunda Prueba de manejo traslapada se rechaza (`slot_taken`) con
  alternativas, venga de quien venga.
- CA-3: El mismo vendedor no puede tener dos citas traslapadas.
- CA-4: El agente no ofrece ni reserva un horario con cualquier cita activa;
  una carrera entre dos reservas de IA al mismo horario deja una sola cita.
- CA-5: El Vendedor no ve ni puede tocar citas de otro vendedor (404); sí ve
  las sin asignar y los bloqueos.
- CA-6: Con `AGENDA` apagada todo lo nuevo responde 404 y la migración se
  aplica igual.
- CA-7: Las citas `is_test` siguen sin tocar conectores ni recordatorios y no
  ocupan la agenda real.
- CA-8: El agente agenda en una conversación de Messenger/Instagram y confirma
  con la dirección; no se programa recordatorio para esa cita.
