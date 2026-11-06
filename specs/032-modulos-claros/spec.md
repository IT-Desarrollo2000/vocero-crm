# 032 — Seguimiento, Citas, Contactos, Catálogo y Reportes que se explican solos

**Carril**: ciclo completo, por fases (A: Seguimiento + Citas · B: Contactos ·
C: Catálogo + Reportes). Cada fase se publica en producción al quedar verde.
Núcleo, sin bandera nueva (Citas sigue detrás de `AGENDA`), sin migración.
Decisión del dueño del 6-nov-2026.

## Contexto
031 dejó la Bandeja «que se explica sola» (sin tooltips, estado visible,
siguiente acción, motivo de lo deshabilitado, «lo que te toca»). El dueño pidió
lo mismo para los demás módulos, donde realmente aplique. Diseño aprobado en
Claude Design: https://claude.ai/artifact/BmkFY5g2n4vJ4wsGohjcPU (7 pantallas).

## Decisiones del dueño (6-nov-2026)
1. Seguimiento: el vendedor sigue viendo los tratos de todos, con «Lo atiende X»
   y sin abrir chats ajenos. Además un filtro **«Mis clientes · Sin tomar ·
   Todos»** (recordado en el navegador; vendedor arranca en «Mis clientes»,
   propietario en «Todos»). No se reordena la columna: el orden es el del arrastre.
2. Citas: el vendedor **puede tomar** una cita sin vendedor («Tomarla»). Solo
   para sí mismo y solo si sigue sin vendedor (atómico). Reasignar a otros sigue
   siendo del Propietario.
3. Contactos: «Ver archivados» se separa en **«Activos / Archivados»** (filtro
   real, no suma).
4. Citas: «Mostrar pruebas» (Laboratorio) se **oculta** a los vendedores.
5. La guía `/ayuda` se **actualiza en cada fase** con los rótulos y pantallas
   nuevos (textos de `src/lib/help/topics.ts` + capturas de
   `scripts/ayuda-capturas.mjs`), agregando los temas que falten (p. ej.
   Seguimiento, Contactos).

## Historias
- **US-1 Seguimiento** (diseño 1): filtro de la decisión 1; franja «lo que te
  toca» (esperan tu respuesta, sin escribirte hace ≥3 días, ventas sin monto,
  citas de mañana); cada tarjeta dice quién la atiende, si espera respuesta, si
  su chat se cerró, su próxima cita, y trae su siguiente paso («Tomar y
  responder», «Retomar con plantilla», «Abrir chat», «Poner/Capturar monto»);
  la de otro vendedor dice «Lo atiende X · solo X abre este chat»; columnas
  vacías con texto; subtítulo de etapa ganada/perdida («ya compró» / «no
  compró»); carga, error con «Reintentar» y fallo de mover/monto visibles;
  se actualiza en vivo (SSE).
- **US-2 Citas** (diseño 2): «lo que te toca»: citas pasadas sin resultado
  («¿Cómo le fue a X?» → «Sí, llegó» / «No asistió» / «Reprogramar»), hoy /
  mañana, citas sin vendedor con «Tomarla» (decisión 2); leyenda reducida y el
  choque dicho en el bloque; hora «de Ciudad de México» (no IANA); filtros
  rotulados («Mías · Sin vendedor · Todas»); «Mostrar pruebas» oculto al
  vendedor (decisión 4); bloqueo que dice que cierra la agenda de todo el
  negocio, con aviso de éxito; instrucciones solo-Propietario cambiadas por
  «pídele al propietario» para el vendedor; sin tooltips (`title`).
- **US-3 Contactos** (diseño 3): acción por fila según estado (Abrir chat ·
  tiempo restante / Retomar con plantilla / Escribir primero / solo contestar
  en IG-Messenger / lo atiende otro); «Escribir primero» con los 3 pasos de la
  plantilla de 031; «Activos / Archivados» (decisión 3); archivar con aviso y
  «Deshacer»; carga y error distintos del vacío; motivos visibles en botones
  deshabilitados.
- **US-4 Catálogo** (diseños 4–5): vendedor: cómo mandar un producto y sus
  atajos con «Copiar»; «Pausado: no se puede mandar» explicado. Propietario:
  «Listo para mandar» / «Le falta: …» por producto, resumen de faltantes,
  «¿Listo para mandar?» y atajos existentes en el detalle; tope de archivos en
  texto.
- **US-5 Reportes** (diseños 6–7): sin íconos ⓘ: definición visible en
  palabras simples bajo cada número; «Lo que toca hoy» con enlaces; tiempos en
  palabras (sin «mediana»/«p90»); zona horaria legible; Ventas sin ventas
  explica cómo se registra una venta y muestra el embudo actual.

## Fuera de alcance
Lógica de arrastre (Seguimiento y calendario), etapas personalizadas, PDF de
reportes, flujo de subida del catálogo, permisos fuera de las decisiones.

## Criterios de aceptación
- CA-1: cada historia se ve y funciona como su pantalla del diseño, con datos
  reales, en claro y oscuro, sin desborde a 390 px.
- CA-2: ningún `title=` usado como explicación ni ícono ⓘ en los módulos
  tocados.
- CA-3: un vendedor toma una cita sin vendedor; si otro la tomó antes, recibe
  el motivo y no se reasigna. Un vendedor no ve «Mostrar pruebas».
- CA-4: «Archivados» muestra solo archivados.
- CA-5: gate verde + E2E de cada fase verde + regresión de los guiones que
  tocan el módulo.
