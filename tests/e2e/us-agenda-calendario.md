# US — Agenda en calendario: Semana, Día por vendedor y arrastrar (028)

Spec: [specs/028-agenda-calendario/spec.md](../../specs/028-agenda-calendario/spec.md).
Extiende Citas (023/025), detrás de `AGENDA` (apagada por defecto).

Automatizado: `scripts/e2e-agenda-calendario.mjs` (Playwright + API, mouse
real). NO está encadenado en `pnpm test:e2e`. Con la app viva y los mocks
(`.env.e2e`, BD aislada `vocero_023` en :5433, puerto 3103), recién migrada
y con el server reiniciado ANTES DE CADA guion (el limitador de login es por
IP y en memoria):

```bash
# encendida
CATALOG_STORAGE=local AGENDA_REMINDER_TICK_MS=0 node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103
E2E_SHOTS_DIR=<carpeta> node --env-file=.env.e2e scripts/e2e-agenda-calendario.mjs

# apagada (la bandera en el server Y en el guion)
AGENDA=off CATALOG_STORAGE=local node --env-file=.env.e2e node_modules/next/dist/bin/next dev -p 3103
AGENDA=off node --env-file=.env.e2e scripts/e2e-agenda-calendario.mjs --off
```

El navegador corre con `timezoneId: "Asia/Tokyo"` y el negocio en
America/Mexico_City: todas las horas tienen que verse en la zona del
NEGOCIO. Las capturas quedan en `E2E_SHOTS_DIR`.

## Preparación (Propietario)
1. Ajustes → Agenda: lun–vie 9:00–18:00, sábado 9:00–13:00, domingo cerrado;
   cada 30 min, sin margen, sin anticipación mínima, 30 días hacia adelante.
2. Equipo: dos Vendedores (Juan y Ana).
3. Día **D** = el primer lunes–viernes a partir de mañana. Agenda:
   - B1 Prueba de manejo 10:00 (Juan) · B2 Servicio 12:00 (Juan);
   - S1 Servicio 14:00 (Juan) y S2 Servicio 14:00 (Ana, "Agendar de todos
     modos");
   - P2 Prueba de manejo 15:00 (Ana) · H Servicio 16:00 (Ana) y un bloqueo
     16:00–17:00 encima de H;
   - M Servicio 9:00 (Ana) · G Servicio sábado 11:00 (Propietario).

## CA-1 — Semana por defecto, en su día y hora
1. En una computadora (1280×800) abre **Citas**: la vista es **Semana**,
   con la leyenda arriba.
2. Ve a la semana de D (› si hace falta).
3. B1 aparece en la columna de D a la altura de las 10:00 (una hora debajo
   de la apertura), B2 dos horas más abajo, y B1 (60 min) mide el doble que
   B2 (30 min). La etiqueta dice "10:00–11:00" aunque la compu esté en Tokio.
4. El sábado se ve sombreado de 13:00 a 18:00; el domingo no tiene huecos.

## CA-2 — Traslapes
1. S1 y S2 se ven lado a lado con el ícono ⧉ (traslape permitido).
2. H, debajo del bloqueo, se ve con borde de alerta y "⚠ Conflicto"; su
   panel de detalle lo explica.

## CA-3 — Clic en hueco libre
1. Toca el hueco de D a las 11:30 → **Nueva cita**.
2. Elige Servicio: el día D y las 11:30 ya están elegidos.

## CA-5 — Arrastrar para mover (mouse)
1. Arrastra B2 a las 13:00: mientras arrastras, la celda dice "… · Libre";
   al soltar, "Cita movida a …". Recarga: sigue a las 13:00.
2. Arrastra M (Ana) a las 13:00, donde está B2 (Juan): la celda dice
   "Ocupado por otro vendedor"; al soltar, **Horario ocupado**. Cancelar →
   M vuelve a las 9:00. Repite y **Mover de todos modos** → M a las 13:00.
3. Arrastra P2 (Prueba de manejo) a las 10:00, encima de B1 (otra Prueba):
   "Ocupado" en rojo; al soltar, aviso "No se puede mover ahí…" y P2 vuelve
   a las 15:00. Lo mismo al sábado 14:00 ("Fuera de horario") y al domingo
   ("Día cerrado"). Ninguno llega al servidor.
4. Un clic simple sobre B1 abre su panel de detalle; no la mueve. En el
   panel, **Reprogramar** abre el diálogo: Escape cierra SOLO el diálogo (el
   panel sigue); un segundo Escape cierra el panel.
5. Camino infeliz: sin red, arrastra B2 a las 17:00 → "Sin conexión con el
   servidor. La cita volvió a su lugar." y B2 sigue a las 13:00.
6. Teclado: foco en G (sábado 11:00) → Espacio → ↓ ↓ → Espacio: G queda a
   las 12:00 (dos pasos de rejilla) y no se abre el panel. Enter sobre un
   bloque, sin arrastrar, abre el panel de detalle.
7. Auto-scroll: con la ventana baja (1280×600) la rejilla tiene scroll
   propio; arrastra una cita de la mañana hasta el borde inferior: el
   calendario se desplaza solo. Suelta en un hueco de la tarde: la hora final
   es la que decía la vista previa justo antes de soltar.

### Límite conocido: la vista previa del Vendedor
El Vendedor solo recibe las citas que puede ver. La vista previa del arrastre
se calcula con eso, así que puede decir **"Libre"** sobre la hora de una cita
de otro vendedor que él no ve (p. ej. otra Prueba de manejo, tipo exclusivo).
Manda el servidor: al soltar responde 409 (`slot_taken` u `overlap_warning`),
se muestra el motivo y la cita vuelve a su lugar o se pide confirmación.

## Error al cargar
1. Si la primera carga del calendario falla (500 o 422), en vez de quedarse
   en "Cargando…" se ve un aviso (`cal-load-error`, `role="alert"`) con el
   motivo y **Reintentar**; al reintentar con el servidor sano se pinta el
   calendario.

## Otra pestaña ya la movió (`stale`)
1. `PATCH /api/bookings/<B2>` `{action:"move", startUtc, expectedStartUtc:<hora vieja>}`
   → 409 `stale`; nada cambia.

## CA-4 — Día por vendedor
1. Propietario → **Día** en D: una columna por miembro del equipo + "Sin
   asignar"; el bloqueo cruza todas como franja.
2. Juan → **Día** en D: solo "Yo" y "Sin asignar"; no ve las citas de Ana.

## CA-6 — Reasignar arrastrando de columna
1. Propietario: arrastra B1 de la columna de Juan a la de Ana, a la misma
   hora → "Cita reasignada."; ahora es de Ana.
2. Juan: arrastra B2 a "Sin asignar" → "Solo el Propietario reasigna", la
   cita vuelve; no se llama al servidor.
3. API: un Vendedor que manda `PATCH move` con `userId` → 403.

## Margen (bufferMinutes = 15)
1. Ajustes → Agenda: margen 15 min. La rejilla del sábado pasa a 9:00, 9:45,
   10:30, …
2. Arrastra G apuntando a las 10:00: la vista previa salta a 9:45 (el
   primer inicio `slot + margen`); al soltar se mueve.
3. Arrastra G a las 12:45: "No cabe antes del cierre" (rechazo sin servidor).
   Nota: dentro del horario el arrastre siempre se ajusta a la rejilla real,
   así que desde la UI no se puede soltar en un inicio desalineado; por API,
   un `move` a las 10:00 con margen → 409 `slot_taken`.

## CA-7 — Celular y tema oscuro
1. A 390×844 Citas abre en **Día**; no hay desplazamiento horizontal de la
   página. En **Semana** el calendario se desplaza por dentro.
2. Con el tema **Oscuro** (cookie `vocero-theme=dark`, botón de tema) la
   leyenda, los bloques y el conflicto se leen bien.

## CA-8 — Agenda apagada
1. Con `AGENDA=off`: `/bookings` → 404 y `GET /api/bookings?from&to` → 404
   (también sin sesión, no 401); `PATCH move` → 404.
