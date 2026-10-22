# 027 — Bandeja por alcance: Buzón · Mis chats · Equipo

**Carril**: ciclo completo, SIN bandera (Bandeja del núcleo), SIN migración.

## Problema (comentario de un vendedor, 22-oct-2026)

"Al atender un chat y volverse mío me gustaría tenerlo en un apartado aparte y
quitarlo del buzón."

Hoy el Vendedor ve en "Todas" sus chats revueltos con los sin asignar
(`conversationVisibleTo`). Contestar ya le asigna el chat (`gateSend`), pero
"Mías" es una vista EXCLUYENTE más (junto a No leídas / Por atender), así que
no puede ver "mis chats por atender" ni "mis no leídas". "De quién es" y "en
qué estado está" son dos preguntas metidas en una sola fila de pestañas.

## Decisiones del dueño (22-oct)

- Selector de ALCANCE encima de las vistas de estado.
- "Mis chats" por defecto (Vendedor).
- El Propietario tiene además la pestaña "Equipo".

## Historias

### US-1 — Alcance y estado en dos niveles
- En modo equipo (`teamMode`) la Bandeja muestra arriba un selector:
  - **Buzón**: sin asignar (la bolsa compartida).
  - **Mis chats**: asignadas a mí.
  - **Equipo** (solo Propietario): asignadas a OTRO miembro.
- Las vistas de estado (Todas · No leídas · Por atender · Archivadas) y el
  panel Filtros (canal, etapa, origen, por cerrar) se aplican DENTRO del
  alcance; sus contadores son del alcance elegido.
- La vista "Mías" y el filtro "Sin asignar" del panel desaparecen (los absorbe
  el selector). Enlaces viejos (`filter=mine`, `filter=unassigned`,
  `unassigned=1`) abren el alcance equivalente.
- Sin modo equipo (instancia de un solo usuario) no hay selector: todo como hoy.
- Con texto en la búsqueda, se busca en TODOS los alcances (aviso "Buscando en
  todos los chats"), para que nadie crea perdido a un cliente que tiene otro
  vendedor o el buzón.

### US-2 — Cada pestaña dice cuánto hay y si hay algo nuevo
- Cada pestaña del selector muestra su total (no archivadas) y un punto de
  acento cuando tiene conversaciones no leídas y no es la pestaña activa.
- Los números se actualizan en tiempo real como los demás contadores.

### US-3 — El chat se muda solo, sin perder el hilo
- Al contestar un chat del Buzón, el Vendedor se lo queda (como hoy) y el chat
  pasa a "Mis chats". El chat ABIERTO no se cierra: sigue en pantalla, sale de
  la lista del Buzón y aparece un aviso "Este chat ahora está en Mis chats ·
  Ir" que cambia de pestaña y lo deja seleccionado.
- El mismo aviso sirve para cualquier chat abierto que no pertenece al alcance
  activo (p. ej. el Propietario lo asignó a otro: "ahora está en Equipo").

### US-4 — Devolver al buzón
- El Vendedor ve "Devolver al buzón" (antes "Liberar conversación") en los
  chats suyos; el chat vuelve al Buzón.

### US-5 — Recordar el alcance
- La Bandeja abre en el último alcance usado por ese navegador; la primera
  vez: Vendedor → Mis chats, Propietario → Buzón (sus respuestas no le
  asignan chats — regla 09 —, así que su "Mis chats" suele estar vacío).
- El alcance va en la URL (`scope=`) como el resto de filtros.

### US-6 — Recordatorio del Buzón (adición del dueño, 22-oct)
- Cuando el Vendedor no tiene nada que hacer en "Mis chats", se le recuerda
  el Buzón con un botón:
  - Vacío de la LISTA en "Mis chats": "Aún no tienes chats." + botón "Ir al
    Buzón (N)" que cambia el alcance (N = `counts.scopes.inbox.all`). Si
    N = 0, solo el texto "El Buzón también está vacío por ahora." (sin botón).
  - Panel DERECHO sin conversación abierta: en modo equipo, con "Mis chats"
    activo y N > 0, debajo del texto de siempre, "Hay N chats esperando en el
    Buzón" + botón "Ver el Buzón". En "Buzón" o "Equipo", sin cambios.
- Ambos se actualizan en tiempo real con los contadores.

## Fuera de alcance
- Filtrar "Equipo" por vendedor concreto.
- Cambiar la regla 09 (el Propietario no se auto-asigna al contestar).
- Badge del menú lateral (sigue contando no leídas visibles).

## Criterios de aceptación
- CA-1: Vendedor con chats propios y sin asignar: "Mis chats" muestra solo los
  suyos; "Buzón" solo los sin asignar; no ve pestaña "Equipo".
- CA-2: Propietario: Buzón + Mis chats + Equipo = Todas (partición exacta).
- CA-3: "Mis chats → Por atender" muestra solo mis chats esperando respuesta y
  su contador coincide.
- CA-4: Vendedor contesta un chat del Buzón → sale del Buzón, entra en Mis
  chats (contadores ±1), el hilo sigue abierto con el aviso y "Ir" lo lleva.
- CA-5: "Devolver al buzón" → vuelve al Buzón.
- CA-6: búsqueda con texto encuentra chats de cualquier alcance.
- CA-7: `/inbox?filter=mine` → Mis chats; `?unassigned=1` / `?filter=unassigned`
  → Buzón.
- CA-8: sin modo equipo no hay selector y la Bandeja funciona como antes.
- CA-9: la API rechaza `assigned` desconocido (422) y `assigned=others` para un
  Vendedor devuelve vacío (no ve chats ajenos).
- CA-10: Vendedor sin chats propios y con N > 0 chats en el Buzón: la lista de
  "Mis chats" muestra "Aún no tienes chats." + "Ir al Buzón (N)" y el panel
  derecho "Hay N chats esperando en el Buzón" + "Ver el Buzón"; ambos botones
  cambian al Buzón. Con N = 0, solo "El Buzón también está vacío por ahora."
  y sin recordatorio en el panel derecho.
