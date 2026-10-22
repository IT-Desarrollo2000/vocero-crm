# 028 — Agenda en calendario (semana, día por vendedor, arrastrar)

**Carril**: ciclo completo. Extiende la pantalla **Citas** (023/025, detrás
de `AGENDA`, encendida en producción). Sin migración prevista.

## Problema
Citas es una lista. Con varios vendedores y tipos exclusivos, el equipo no ve
de un vistazo qué horas están libres, ocupadas o traslapadas, ni quién está
disponible.

## Decisiones del dueño (22-oct-2026)
1. Tres vistas: **Semana**, **Día por vendedor** y la **Lista** actual.
2. Vista por defecto en computadora: **Semana** (en celular: Día/Lista).
3. **Arrastrar para mover** desde ya.
4. Colores que distingan ocupado, traslapado, bloqueo, etc.

## Historias

### US-1 — Vista Semana (por defecto en computadora)
- Columnas lun–dom, filas por hora; el rango visible va de la apertura más
  temprana al cierre más tardío del horario semanal. Las horas fuera del
  horario de cada día se ven sombreadas (no reservables).
- Cada cita es un bloque proporcional a su duración con: hora, cliente,
  tipo e iniciales del vendedor.
- Citas que se traslapan se dibujan lado a lado.
- Navegación: semana anterior / siguiente / "Hoy"; línea de la hora actual.
- Clic en hueco libre → "Nueva cita" con día y hora prellenados.
- Clic en una cita → panel de detalle con las acciones existentes
  (reprogramar, cancelar, marcar realizada/no asistió, reasignar, enlace,
  recordatorios).

### US-2 — Vista Día por vendedor
- Un día; una columna por vendedor visible + "Sin asignar" (+ bloqueos
  ocupan todas las columnas como franja gris).
- El Vendedor ve su columna, "Sin asignar" y las citas que puede ver; el
  Propietario ve a todo el equipo.

### US-3 — Lista
- La lista actual se conserva tal cual (con sus filtros).
- En pantallas angostas la vista inicial es Día (o Lista); Semana sigue
  disponible pero con desplazamiento horizontal dentro del calendario (nunca
  de la página).

### US-4 — Colores y leyenda
Leyenda visible. Estados (color de fondo/borde):
- **Agendada** — color de acento de la marca (tinte + borde).
- **Traslapada** — ámbar (advertencia) con borde marcado: la cita choca con
  otra cita activa en ese horario (cualquier vendedor/tipo).
- **Bloqueo** — gris rayado.
- **Realizada** — verde apagado.
- **No asistió** — rojo apagado.
- **Cancelada** — oculta por defecto; con "Mostrar canceladas", tachada y
  translúcida.
- **Fuera de horario** — fondo gris del calendario.
- El **tipo** se indica con un punto/etiqueta de color propio por tipo
  (paleta fija, estable por tipo) dentro del bloque.
- Todo en temas claro y oscuro con tokens; no se depende solo del color
  (ícono/texto para traslapada y estados).

### US-5 — Arrastrar para mover
- Semana: arrastrar una cita a otra hora/día (ajuste a la rejilla de
  `slot_minutes`). Día por vendedor: arrastrar a otra hora y/o a otra
  columna de vendedor (reasignar; solo Propietario).
- Al soltar se aplican las MISMAS reglas que al reprogramar/reasignar:
  - choque con tipo exclusivo, con el mismo vendedor, con un bloqueo o fuera
    de horario → rechazo; la cita vuelve a su lugar con el motivo;
  - choque con la cita de otro vendedor → diálogo "A esa hora ya hay …
    ¿Mover de todos modos?"; cancelar devuelve la cita.
- Mientras se arrastra, la celda destino muestra si está libre, ocupada o
  fuera de horario.
- Solo se arrastran citas que el usuario puede modificar (agendadas, no
  pasadas, no de prueba); los bloqueos se mueven en Semana.
- Alternativa accesible: el panel de detalle conserva "Reprogramar" y
  "Reasignar" (sin necesidad de arrastrar); `@dnd-kit` con teclado.

## Fuera de alcance
- Redimensionar (cambiar duración) arrastrando el borde.
- Vista mensual.

## Criterios de aceptación
- CA-1: Semana muestra las citas en su día y hora (zona del negocio), con
  duración proporcional, y es la vista inicial en computadora.
- CA-2: dos citas traslapadas se ven lado a lado y en color "traslapada".
- CA-3: clic en hueco libre abre Nueva cita con esa fecha y hora.
- CA-4: Día por vendedor muestra una columna por vendedor y respeta la
  visibilidad del Vendedor.
- CA-5: arrastrar a un hueco libre mueve la cita (persiste tras recargar);
  a un choque con otro vendedor pide confirmación; a un tipo exclusivo
  ocupado o fuera de horario la rechaza y la regresa.
- CA-6: arrastrar a otra columna (Propietario) reasigna; un Vendedor no
  puede reasignar arrastrando.
- CA-7: sin desplazamiento horizontal de página a 390 px; temas claro y
  oscuro legibles.
- CA-8: con `AGENDA` apagada nada de esto existe (404 de siempre).
