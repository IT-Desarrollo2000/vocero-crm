# 035 — Recordatorios, Pendientes y avisos

**Origen**: capacitación de ventas (nov-2026). Petición del equipo:

> Muchas veces queremos poner recordatorios o tener una agenda donde podamos
> asignar recordatorios para volver a contactar leads o clientes, ya sea por
> recordatorios de servicio, cita, etc. o solamente por contacto (p. ej. el
> cliente pide que se le recuerde cuando ya llegaron modelos nuevos).

Claude Design (APROBADO 11-nov-2026, 4 pantallas en `diseno/`):
https://claude.ai/artifact/CubbstamFdUJ8X9RDmCR6F

## Decisiones del dueño
- Recordatorios **solo internos** (al vendedor, nunca al cliente). Sin
  WhatsApp al vendedor, sin email.
- Cada vendedor ve **los suyos**; el Propietario ve todos con filtro por
  vendedor (supuesto presentado y no objetado).
- **Sin** liga al catálogo («llegó el modelo» descartado).
- Envío masivo de plantillas desde «Sin contacto»: DESCARTADO por ahora.

## Entrega por fases (cada una se publica sola)

### Fase A — Recordatorios y Pendientes (P1)
- **«Recordarme»** desde el chat (encabezado), la tarjeta de Seguimiento y la
  fila de Contactos: cuándo (atajos Mañana / En 3 días / En 1 semana / En 1 mes
  + día y hora, hora del negocio), motivo (Volver a contactar · Servicio ·
  Información solicitada · Cita · Otro), **Repetir** (no / cada 3, 6, 12
  meses), nota opcional. Muestra los recordatorios abiertos de ese cliente.
- **Seguimiento › «Tablero | Pendientes»**:
  - *Mis recordatorios*: Vencidos (rojo) y Hoy completos; Esta semana y
    Después plegados. Filtro por motivo con contadores. Acciones: Contactar
    (abre el chat; si la ventana cerró, listo para plantilla), Hecho (con
    «¿Qué pasó?» opcional que queda en el historial del cliente; si se repite,
    crea el siguiente y lo dice), Posponer (1 h, mañana, 1 semana, otra fecha).
  - *Sin contacto*: se arma sola con los clientes del vendedor sin mensajes
    (entrantes ni salientes) desde hace +15/30/60/90 días, o **Entre fechas**
    (último mensaje entre Desde y Hasta). «Incluir perdidos» (apagado por
    defecto). Si ya tiene recordatorio, lo dice y no ofrece «Recordarme».
  - *Sin respuesta a tu plantilla*: clientes cuyo último mensaje es una
    plantilla saliente sin respuesta desde hace +3/7/14 días, con su estado
    (entregada/leída) y «Dar seguimiento» / «Recordarme».
  - Listas largas: cada recuadro muestra 3 y un botón «Ver los N» que
    expande con desplazamiento interno (máx. 8 a la vista); el de abajo no se
    mueve.
  - Número rojo de vencidos junto a «Seguimiento» en el menú.
- Propietario: filtro «Vendedor: Todos / …» en Pendientes.

### Fase B — Avisos (P1)
- Campana junto al nombre del negocio con contador: recordatorio vencido,
  resumen del día («Hoy tienes N recordatorios»), «Te asignaron a …» (chat o
  cita). Marcar leído / todo leído.
- Aviso emergente dentro del CRM al vencer un recordatorio (Contactar ·
  Posponer 1 h), por SSE en vivo.
- Avisos del navegador opcionales (Notification API, el usuario los activa).
- «Esto es lo que te toca ahora» de la Bandeja suma «N recordatorios para hoy
  (M vencidos)».

### Fase C — Sugerir al cerrar (P2)
- Al marcar «Perdido» (tras el motivo): «¿Te recuerdo volver a intentar con
  …?» 1/3/6 meses → recordatorio «Volver a contactar» con nota del motivo.
- Al marcar una cita «No asistió»: «¿Te recuerdo escribirle mañana?» → motivo
  «Cita». Ignorarla no hace nada.

## Restricciones
Multi-tenancy (`organization_id` + `scoped()`), Zod en todo input, toda ruta
nueva clasificada en `src/lib/permissions.ts`, migración re-ejecutable,
horas en la zona del negocio (como Citas), conversaciones `is_test` fuera de
las listas, sin tooltips (la pantalla se explica sola).

## Criterio de hecho (por fase)
Gate técnico + E2E propio conectado al self-test, en BD aislada, + capturas
revisadas contra el diseño antes de publicar.
