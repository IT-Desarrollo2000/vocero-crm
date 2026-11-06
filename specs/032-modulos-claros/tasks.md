# 032 — Tareas

## Fase A — Seguimiento + Citas
- [x] A1 `tz-label.ts` + test
- [x] A2 `/api/pipeline/board` ampliado + `pipeline-card.ts` + tests
- [x] A3 UI Seguimiento (filtro, franja, tarjetas, estados, SSE)
- [x] A4 «Tomarla» en API + permisos + tests
- [x] A5 `bookings-todo.ts` + UI Citas
- [x] A6 Ayuda: tema Seguimiento nuevo + Citas al día + capturas
  (`seguimiento.png`, `citas.png`, `cita.png` rehecha; revisión visual claro/
  oscuro, 1366/390: «p. m..» doble, hora partida en dos renglones, ícono ⓘ
  del aviso de Citas y segmentado «Mías · Sin vendedor · Todas» al diseño)
- [x] A7 E2E `e2e-modulos-a.mjs` + regresión (agenda-*, cita-cliente, archivo-ui, roles, responsive, ayuda, selftest)
  — `e2e-modulos-a` 81/81 y regresión verde (6-nov). `e2e-cita-cliente` 61/61
  tras un ajuste solo de arnés: «Cargando datos del cliente…» cuenta como
  tarjeta abierta (en `next dev` la primera carga tarda ~5 s y el reintento de
  clic la cerraba y reabría). `e2e-agenda-calendario` re-corrido con el código
  final: 125/0.
- [ ] A8 Merge, deploy y verificación en vivo

## Fase B — Contactos
- [ ] B1 `/api/contacts` (archivados real + conversación) + `contact-row.ts` + tests
- [ ] B2 UI Contactos + «Escribir primero» con los 3 pasos
- [ ] B3 Ayuda (tema Contactos) + capturas
- [ ] B4 E2E + regresión (contactos-paginacion, search-filters, responsive) + deploy

## Fase C — Catálogo + Reportes
- [ ] C1 `catalog-readiness.ts` + UI Catálogo (vendedor y propietario)
- [ ] C2 Reportes sin ⓘ, «Lo que toca hoy», textos llanos, Ventas vacía
- [ ] C3 Ayuda (Catálogo) + capturas
- [ ] C4 E2E + regresión (catalogo, metricas, selftest) + deploy
