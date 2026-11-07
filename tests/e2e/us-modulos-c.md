# E2E — 032 Fase C: Catálogo y Reportes que se explican solos

Guion de comportamiento observable. Spec:
[specs/032-modulos-claros/spec.md](../../specs/032-modulos-claros/spec.md)
(US-4, US-5, CA-1, CA-2, CA-5). Diseños:
`specs/032-modulos-claros/diseno/Catalogo-vendedor.dc.html`,
`Catalogo-propietario.dc.html`, `Reportes-resumen.dc.html` y
`Reportes-ventas.dc.html`.

Automatizado en `scripts/e2e-modulos-c.mjs` (Playwright; Propietario y
vendedora «Daniela Ortiz», los dos por API):

```bash
# BD aislada RECIÉN RESETEADA, app viva con .env.e2e (mocks, AGENDA=on,
# CHANNELS con instagram) y CATALOG_STORAGE=local EXPLÍCITO (en el server y
# en el guion: `next dev` también lee .env). Lee DATABASE_URL para dejar una
# cita en el pasado.
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-c.mjs
# Con REVISAR_DIR=<dir> deja fotos de cada pantalla para revisarlas a ojo.
```

Datos: tres chats de WhatsApp con la IA apagada — Andrea (respondida), Bruno
(de Daniela, sin responder) y Carla (respondida, pasada a «Cliente» sin monto
y con un saliente que Meta rechaza con 131026); con `AGENDA`, una cita de
Andrea retrocedida a ayer sin resultado. Catálogo: Lisboa (2 fotos, ficha,
.txt y sus 2 atajos), Nogal (1 foto, atajo de fotos, sin ficha), Roble
(pausado), Mesa de centro (sin código ni fotos) y Librero (sin fotos ni
atajos); con Instagram, un DM.

---

## Reportes (Propietario)

### a) Sin pendientes y sin ventas
1. Con solo el chat de Andrea (respondido), abre Reportes → Resumen.
   **Esperado**: «Lo que toca hoy» dice «Nada pendiente: nadie espera
   respuesta y no falta capturar nada.» y no trae accesos.
2. Ventas. **Esperado**: `sales-empty` «Todavía no hay ventas registradas…»,
   «Una venta se cuenta cuando… «Cliente»…», el embudo de hoy
   (`sales-empty-funnel`, con «Nuevo») y ningún KPI de ventas. «Ir a
   Seguimiento» abre `/pipeline`.

### b) Con pendientes
1. Bruno escribe y queda a nombre de Daniela sin respuesta; Carla pasa a
   «Cliente» sin monto; la cita de Andrea quedó ayer sin marcar.
2. Resumen. **Esperado** en «Lo que toca hoy»: «1 persona espera respuesta ·
   Ir a la Bandeja», «1 sin responder de Daniela Ortiz · Ver Vendedores»,
   «1 venta sin monto: no suma al total · Captúralo en Seguimiento» y (con
   la agenda) «1 cita ya pasó y nadie marcó si vino · Márcalas en Citas».
3. Desde `?range=7d`, clic en cada uno. **Esperado**: Bandeja en «Equipo ·
   Por atender» (`scope=team&filter=human`: el único pendiente es de
   Daniela; si la mayoría estuviera sin tomar, el Buzón) con Bruno;
   Vendedores con el mismo rango (`range=7d`) y su tabla; Seguimiento con
   Carla; Citas con su franja.
4. Ventas. **Esperado**: ya no sale `sales-empty`: KPI de ventas, «Ventas por
   día» y el aviso de la venta sin monto.

### c) Las pestañas (Resumen, Agente, Citas, Ventas, Vendedores, Anuncios)
- Bajo cada número su definición en palabras, visible (y como descripción
  de la tarjeta para el lector de pantalla).
- Ningún ícono ⓘ ni atributo `title` en `main`. Única excepción aceptada: el
  nombre recortado de un anuncio en Anuncios (lleva el nombre completo).
- Ningún «mediana», «p90» ni «percentil».
- La zona dice «hora de Ciudad de México», nunca «America/Mexico_City».

### d) Agente
- «Pasadas a una persona» (ya no «Escalamientos») y «Mensajes que no
  salieron».
- En «Por qué no salieron», el 131026 en una frase: «El destinatario no
  puede recibir mensajes de WhatsApp…», con «código Meta 131026» aparte y sin
  el crudo «(#131026)».

### e) «Descargar PDF» mientras carga
1. Con la respuesta del Resumen retenida. **Esperado**: el botón
   deshabilitado, junto a él «Se activa cuando el reporte termina de
   cargar.» (`report-print-reason`, ligado por `aria-describedby`), sin
   `title`.
2. Al llegar los datos. **Esperado**: habilitado y sin el motivo.

### f) Impresión del Resumen
- Con `media: print`: «Lo que toca hoy» no sale; sí el encabezado del
  reporte y la definición de cada KPI; sin pestañas ni botón; sin desborde.

### g) La vendedora no entra
- `/reports/summary` → 404; `/api/reports/summary` → 403/404; «Reportes» no
  está en su menú.

## Catálogo

### h) Vendedora
1. Abre «Catálogo». **Esperado**: «Para mandarle un producto a un cliente:»
   con «Abre su chat en la Bandeja» y «Toca «Catálogo», o escribe el atajo…»,
   y «Aquí solo se consulta; los productos los carga el propietario.». Sin
   resumen de faltantes.
2. Lisboa: «Escríbelo en el chat para mandarlo:» y sus 2 atajos con
   «Copiar». Clic en «Copiar» de `/fotos_…`. **Esperado**: «Copiado» y el
   portapapeles tiene `/fotos_…`; a los 2 s vuelve a «Copiar».
3. Nogal: 1 atajo y «Sin ficha PDF. Desde «Catálogo» en el chat puedes
   mandar solo las fotos.». Mesa de centro: «Sin atajo todavía…» y «Sin fotos
   todavía: pídele al propietario que las suba.».
4. Roble: «Pausado: no se puede mandar» y «El propietario lo pausó (por
   ejemplo, porque se agotó)…». En su detalle, el mismo motivo y «Mientras
   esté pausado, sus atajos no aparecen en el chat.».
5. Nada de «Le falta», «Listo para mandar», «¿Listo para mandar?» ni «Crear
   atajos»; ningún `title` ni ⓘ. En el detalle de Lisboa: sus atajos con
   «Copiar», «Cópialo y pégalo en el chat del cliente…» y «4 de 20».
6. Sin portapapeles (navegador que no lo da). **Esperado**: «No se pudo
   copiar: escribe /fotos_… en el chat.».

### i) Propietario
1. **Esperado** el resumen: «2 productos no se pueden mandar completos
   todavía», con «Mesa de centro… no tiene fotos y no tiene código…» y
   «Librero… no tiene fotos…», la nota «A 1 producto solo le falta la ficha
   PDF…» y «1 producto está pausado…».
2. Por tarjeta: Lisboa «Listo para mandar», Nogal «Le falta: ficha PDF»,
   Mesa «Le falta: fotos y código», Librero «Le falta: fotos y atajos», Roble
   «Pausado: no se puede mandar».
3. Detalle del Librero. **Esperado**: «¿Listo para mandar?» con «Precio:
   $9,400», «Sin fotos…» y «Sin atajos todavía.»; los dos atajos «Falta
   crearlo». Clic en «Crear atajos». **Esperado**: los dos ligados con
   «Copiar», «Ya existen los dos; volver a tocarlo no cambia nada.», el
   resultado «created» de cada uno y la tarjeta en «Le faltan las fotos».
4. Sube una foto (`CATALOG_STORAGE=local`). **Esperado**: subida «done»,
   «¿Listo para mandar?» sin faltantes, la tarjeta «Listo para mandar», el
   resumen en «1 producto no se puede mandar completo todavía»; «2 de 20 ·
   caben 18 más» y «Hasta 20 archivos por producto.».
5. Lisboa con 20 archivos. **Esperado**: «20 de 20 · ya no caben más», «Ya
   tiene los 20 archivos que caben en un producto: borra uno para subir
   otro.» a la vista, y «Subir fotos o ficha» deshabilitado y descrito por
   ese texto (sin `title`).

### j) Bandeja: panel «Catálogo» en Instagram (CA-2)
- En un chat de Instagram, panel «Catálogo» → Lisboa. **Esperado**: el `.txt`
  con su casilla deshabilitada y, debajo del nombre, «No se puede mandar por
  aquí: Instagram solo acepta…» completo (sin recortar), a 1366 y a 390 px;
  ningún `title` en el panel.

## k) Claro y oscuro, 1366 y 390 px
- `/catalog` (vendedora y Propietario, con el detalle abierto) y las
  pestañas de `/reports`: el tema aplicado, sin desborde horizontal y
  ninguna tarjeta desbordada por dentro.
