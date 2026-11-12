# US — Avisos (035 fase B): campana, aviso emergente, navegador y Bandeja

Contrato: [specs/035-recordatorios/spec.md](../../specs/035-recordatorios/spec.md) § Fase B ·
plan: [specs/035-recordatorios/plan-b.md](../../specs/035-recordatorios/plan-b.md) ·
diseño: `specs/035-recordatorios/diseno/Avisos.dc.html`.

Automatizado en `scripts/e2e-avisos.mjs` (navegador + API, BD aislada) y, por
API, en `avisosChecks()` de `scripts/e2e-selftest.mjs`.

## Entorno

- BD AISLADA (Postgres Docker `:5433`, `.env.e2e`), nunca la de producción.
- `NOTIFICATIONS_TICK_MS=0`: el reloj de avisos solo avanza con
  `POST /api/dev/notifications/tick { now?: ISO }` (un emergente espontáneo
  taparía clics en los demás guiones).
- Independiente de la hora: los recordatorios que vencen quedan para MAÑANA
  07:00 y el tick se fuerza a mañana 07:01 (antes de las 08:00: sin resumen);
  el resumen del día se prueba con otro tick forzado a HOY 23:59 (siempre
  ≥ 08:00 y siempre hoy). No hace falta saltarse nada cerca de medianoche.
  Lo que usa la hora real (número rojo, línea de la Bandeja) se siembra con
  un recordatorio de AYER.

## Guion

1. **Bandeja**: Vera (Vendedora) sin chat abierto ve «1 recordatorio para hoy
   (1 vencido)» · «Ábrelos en Seguimiento › Pendientes.» (tono acento) y el
   número rojo junto a «Seguimiento». Clic → `/pipeline?vista=pendientes`.
2. **Te asignaron a … (chat)**: el Propietario le asigna un chat → la campana
   de Vera sube EN VIVO; el aviso dice «Te asignaron a Patricia …» ·
   «<Propietario> la pasó a tu nombre · ahora mismo · Abrir chat».
3. **Te asignaron la cita de …**: el Propietario crea una cita para Bruno
   (Bruno recibe el aviso) y la reasigna a Vera → «Te asignaron la cita de
   Sofía … · mañana HH:MM» · «Ver cita» (→ Citas).
4. **No avisa**: Vera toma un chat del Buzón; Vera «Toma» una cita sin
   vendedor; el Propietario se asigna un chat a sí mismo.
5. Clic en un aviso → leído («Leído · ahora mismo»). Escape cierra el panel y
   devuelve el foco a la campana; clic fuera también lo cierra.
6. **Resumen del día** (tick hoy 23:59): «Hoy tienes 1 recordatorio (1
   vencido)» · «Ver en Seguimiento › Pendientes»; no saca aviso emergente.
7. **Recordatorio vencido** (tick mañana 07:01): con la página abierta
   aparecen EN VIVO 2 avisos emergentes (abajo a la derecha, `role="status"`):
   «Recordatorio: Laura …» · «Información solicitada · «nota»» · Posponer 1 h
   · Contactar · ×. La campana: «Recordatorio vencido: Laura … · Información
   solicitada», nota y hora, Contactar y Posponer ▾ (1 hora · Mañana · 1
   semana). El de AYER no se avisa (solo vencidos de las últimas 24 h).
8. Repetir los dos ticks con la misma hora → no se crea nada (UNIQUE).
9. **Nadie más**: Bruno y el Propietario no ven emergente; su API no trae
   nada de Vera; el SSE crudo del Propietario no lleva ningún
   `notification.changed` (filtro `canReceive`).
10. **Navegador**: pie «¿Quieres el aviso aunque estés en otra pestaña?» →
    «Activar avisos del navegador» → «Avisos del navegador activados» ·
    «Desactivar». Con la pestaña oculta, una asignación lanza la notificación
    del sistema (en headless se simula `Notification`, que Chromium headless
    siempre informa como bloqueado).
11. **Posponer 1 h** desde el emergente → se va, el recordatorio queda a +1 h
    y su aviso leído. **Contactar** → abre el chat de Marta, aviso leído.
12. El Propietario marca Hecho uno de Vera → su número rojo se apaga EN VIVO
    (SSE `follow_ups.changed`, sin recargar) y la línea de la Bandeja deja de
    contar vencidos. El aviso pospuesto dice «Lo pospusiste para …».
13. **Marcar todo como leído** → sin contador; API `unread = 0`.
14. 390 px: la campana está en el encabezado y el panel cabe sin scroll
    horizontal. Lateral contraído: la campana debajo de la inicial.
15. Reloj con fecha ilegible → 422 y `/api/health` sigue 200; sin sesión →
    401; Bruno marcando leído uno de Vera → 0 cambiados; `ids: []` → 422.
16. Sin `title` (tooltips) en la campana, el panel ni los emergentes.

Un fallo del reloj (BD caída, excepción síncrona) solo se registra y la
siguiente vuelta corre: lo cubre `tests/unit/notifications-ticker.test.ts`.
