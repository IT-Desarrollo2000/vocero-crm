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
- [x] B5 Merge, deploy y verificación en vivo — EN PROD 4fdbaac (6-nov,
  deploy gczapwxmrwb5aw3uzpre88fc, healthy, sin migración; reversa 581362a)

## Fase C — Catálogo + Reportes
- [x] C1 `catalog-readiness.ts` + UI Catálogo (vendedor y propietario) — 8e72aba
- [x] C2 Reportes sin ⓘ, «Lo que toca hoy», textos llanos, Ventas vacía —
  8e72aba + ajustes de C4: «N personas esperan respuesta» lleva a la vista de
  la Bandeja donde están (Buzón si la mayoría está sin tomar, si no «Equipo»,
  siempre «Por atender»); sin datos del periodo anterior no se compara
  («nuevo vs. …»), como en el diseño; «A 1 nadie le ha respondido»; las
  tablas `sr-only` de los gráficos (Agente, Ventas) desbordaban la página a lo
  ancho: van dentro de un div `sr-only` que las recorta
- [x] C3 Ayuda (Catálogo) + capturas — tema `catalogo` al día («Desde el
  chat» y «Con su atajo»: «Para mandarle un producto a un cliente:»,
  «Copiar»/«Copiado», «Pausado: no se puede mandar», «Sin fotos todavía:
  pídele al propietario…», «Sin atajo todavía», «No se pudo copiar…», «No se
  puede mandar por aquí: …»), sin rótulos del Propietario ni Reportes;
  `catalogo.png` rehecha y `catalogo-atajos.png` nueva (vendedora, como el
  diseño); `help-topics`, `e2e-ayuda` (normal y `--off`), `us-ayuda.md`,
  `contenido.md`. CA-2 heredado: el panel «Catálogo» de la Bandeja ya no
  explica con `title` por qué un archivo no sale (texto visible completo)
- [x] C4 E2E + regresión — `e2e-modulos-c` 229/229 (`us-modulos-c.md`) con el
  código final. Regresión verde con el código final: catalogo 125/125,
  metricas 83, leads-externos 121/121, recordatorios 75/75, ayuda 127/127 +
  `--off` 25/25, responsive 54, roles 116/116, adjuntos-ui 39/39, modulos-a
  81/81, modulos-b 100/100, selftest 651/651. Revisión claro/oscuro 1366/390
  de /catalog (dos roles) y /reports (seis pestañas) + impresión del Resumen.
  Gate verde (185 archivos, 2546 tests)
- [ ] C5 Merge, deploy y verificación en vivo
