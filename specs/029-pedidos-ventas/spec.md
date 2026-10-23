# 029 — Pedidos de ventas: respuestas rápidas del equipo y cliente en la cita

**Carril**: ciclo completo. Tres pedidos del equipo de ventas (23-oct-2026).
Toca Bandeja (núcleo, sin bandera) y Citas (detrás de `AGENDA`, encendida en
producción). Una migración: `0028` (columna en `inbox_settings`).

## Problema
1. Los vendedores usan las respuestas rápidas pero no pueden crearlas: solo el
   Propietario (API 403, página de ajustes oculta).
2. En el detalle de una cita no se ve de qué conversación salió ni los datos
   del lead (teléfono, canal, etiquetas, anuncio de origen).
3. Los botones del detalle de cita casi no se distinguen del fondo
   (`secondary` `#17181d` sobre panel `#101115`) y «Cancelar» es un `ghost`
   sin borde aunque sea destructivo.

## Decisiones del dueño (23-oct-2026)
1. Respuestas rápidas: siguen siendo **de toda la organización**. Cualquier
   miembro crea; cada Vendedor edita/borra **solo las suyas**; el Propietario
   todas. Las vinculadas a un producto del catálogo (`product_id`/`attach`)
   y el orden (`position`) siguen siendo solo del Propietario.
2. Interruptor del Propietario «Vendedores pueden crear respuestas rápidas»
   **desde ya** (encendido por defecto, que es lo que pidió ventas).
3. Cita cuyo chat el Vendedor no ve (asignado a otro): se oculta todo
   **menos el teléfono** (y el nombre, que ya se ve). El Propietario ve todo.
4. (23-oct, añadido) Una cita **sin vendedor asignado** (p.ej. la agendó la
   IA) muestra los datos completos a cualquier Vendedor. Por extensión, la
   cita asignada a ese Vendedor también se ve completa. Regla:
   `completo = Propietario ∨ cita sin asignar ∨ cita asignada a mí ∨ veo el chat`.
   El botón «Abrir conversación» sigue dependiendo de ver el chat (la Bandeja
   no lo abriría): si no lo ve, deshabilitado con «Chat asignado a X».

## Historias

### US-1 — El Vendedor crea respuestas rápidas para todo el equipo
- En el menú de `/` del compositor, al final: «+ Nueva respuesta rápida».
- En el compositor, con texto escrito: «Guardar como respuesta rápida»
  (prellena el cuerpo con lo escrito).
- Ambos abren el mismo diálogo (atajo, título, cuerpo con variables). Atajo
  repetido → mensaje claro, no se pierde lo escrito.
- La pestaña Ajustes → Respuestas rápidas la ve también el Vendedor: lista
  completa con el **autor** de cada una; editar/borrar solo en las suyas;
  sin reordenar; sin vínculo a producto.
- Con el interruptor apagado: el Vendedor no ve las entradas de crear, la
  página queda en solo lectura y la API responde 403 a sus escrituras.

### US-2 — El Propietario controla quién crea
- En Ajustes → Respuestas rápidas (solo Propietario): interruptor
  «Vendedores pueden crear respuestas rápidas». Sin fila de ajustes = encendido.
- El Propietario sigue pudiendo todo, como hoy.

### US-3 — Cliente en el detalle de cita
- El panel de detalle (Semana/Día) y la fila de la vista Lista muestran una
  sección **Cliente**: nombre, teléfono con botón copiar (o «Sin teléfono»
  si la identidad es `bsuid:`), canal, etiquetas y la tarjeta del anuncio de
  origen (`AnuncioOrigen`), más el botón **Abrir conversación**
  (`/inbox?contact=<id>`).
- Los datos se piden al abrir la cita (no engordan `GET /api/bookings`).
- Conversación de la cita: `booking.conversation_id`; si es null, la más
  reciente (no de prueba) del contacto; si no hay ninguna, «Sin
  conversación» y no hay botón.
- Datos completos según la regla de la decisión 4; si no aplica (cita
  asignada a otro Vendedor y chat ajeno): solo nombre + teléfono.
- Si el Vendedor no ve el chat, el botón queda deshabilitado con «Chat
  asignado a <nombre>» (aunque vea los datos completos).
- Bloqueos (sin contacto): no hay sección Cliente.
- Fallo al cargar: aviso «No se pudieron cargar los datos del cliente» +
  reintentar; el resto del panel funciona.

### US-4 — Botones claros en el detalle de cita
- Grupo **Resultado**: «Realizada» primario (verde de marca), «No asistió»
  con borde visible.
- Grupo **Cambios**: «Reprogramar», «Reasignar» con borde visible y texto claro.
- **Cancelar cita** / **Quitar bloqueo** separado al final, en rojo (borde y
  texto) y con confirmación.
- Reintentos (enlace, recordatorio) con borde visible.
- Sin cambiar la variante `secondary` global.

## Criterios de aceptación
- CA-1 Vendedor crea desde `/` y desde «Guardar como…»; aparece al instante
  para otro usuario de la org.
- CA-2 Vendedor edita/borra la suya; 403 al editar/borrar la de otro, una
  vinculada a producto, o al mandar `productId`/`attach`/`position`.
- CA-3 Interruptor apagado: 403 al crear como Vendedor y sin entradas en la UI;
  el Propietario sigue creando.
- CA-4 Detalle de cita muestra teléfono, canal, etiquetas, anuncio y abre la
  conversación correcta en la Bandeja.
- CA-5 Vendedor, cita asignada a otro y chat ajeno: solo teléfono; botón
  deshabilitado con el nombre del responsable; la API no devuelve
  canal/etiquetas/anuncio.
- CA-5b Vendedor, cita SIN asignar (agendada por la IA) con chat ajeno: datos
  completos; botón deshabilitado «Chat asignado a X».
- CA-6 Cita de otro (que el Vendedor no puede ver) → 404 en el endpoint.
- CA-7 Botones con borde visible; «Cancelar cita» pide confirmación y es rojo.
