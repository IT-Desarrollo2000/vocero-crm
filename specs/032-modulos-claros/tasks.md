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
- [x] A8 Merge, deploy y verificación en vivo — EN PROD 581362a (6-nov,
  deploy xwhgsnluwu3ay9t68kgwdvgv, healthy, sin migración; reversa d4a6f83)

## Fase B — Contactos
- [x] B1 `/api/contacts` (archivados real + conversación) + `contact-row.ts` + tests
- [x] B2 UI Contactos + «Escribir primero» con los 3 pasos
- [x] B3 Ayuda (tema Contactos) + capturas — tema `contactos` tras
  `seguimiento` (rótulos de la pantalla; «¿Y en Instagram y Messenger?» solo
  con esos canales), `contactos.png` (abierto, cerrado, nunca escribió,
  Instagram, de Marco, «Tomar y responder», aviso con «Deshacer»); test
  `help-topics`, `e2e-ayuda` (normal y `--off`), `us-ayuda.md`,
  `contenido.md`. Revisión claro/oscuro 1366/390 vendedora y propietario
- [x] B4 E2E + regresión — `e2e-modulos-b` 100/100 (6-nov; `us-modulos-b.md`;
  los dos estados sin chat, WhatsApp sin teléfono e Instagram, sembrados por
  SQL). Regresión verde con el código final: contactos-paginacion 26,
  search-filters 59, responsive 54, alertas 53, modulos-a 81/81, ayuda
  114/114 + `--off` 12/12, bandeja-alcance 66/0, roles 116/116, asignacion
  86/86, archivo-ui 46/46, templates-multivar 21/21, alta-manual 14/14,
  selftest 651/651. Gate verde (183 archivos, 2512 tests). Guiones existentes
  solo con cambios aditivos de B3: `e2e-ayuda` (tema nuevo) y
  `ayuda-capturas` (siembra y captura de Contactos, `/contacts` en la
  revisión).
- [ ] B5 Merge, deploy y verificación en vivo

## Fase C — Catálogo + Reportes
- [ ] C1 `catalog-readiness.ts` + UI Catálogo (vendedor y propietario)
- [ ] C2 Reportes sin ⓘ, «Lo que toca hoy», textos llanos, Ventas vacía
- [ ] C3 Ayuda (Catálogo) + capturas
- [ ] C4 E2E + regresión (catalogo, metricas, selftest) + deploy
