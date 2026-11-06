# 032 — Auditoría de UI (6-nov-2026, solo lectura)

Hallazgos con archivo:línea al 5daaa6c. Fuente de verdad de textos y
maquetación: los artboards del diseño (copia local en el scratchpad de la
sesión: `canvas032/project/*.dc.html`).

## 1. Seguimiento (`/pipeline`)
- Tablero `src/components/pipeline/pipeline-client.tsx`; panel `lead-drawer.tsx`;
  `amount-dialog.tsx`, `loss-reason-dialog.tsx`, `stage-manager.tsx` (solo
  Propietario, «Gestionar etapas» `:182-186`). Datos: `GET /api/pipeline/board`
  (no filtra por responsable: el Vendedor ve todos los tratos).
- Sin carga (`:197-210` deja blanco), sin vacío, errores tragados: `refetch`
  hace `return` si `!res.ok` (`:73-74`); mover/monto/prioridad
  `.catch(() => null)` + `refetch()` (`:104-115`, `:122-128`, `:135-140`).
- Sin SSE: `onConversationUpdated` / `onMessageNew` existen en
  `src/components/use-events.ts`.
- Ícono de chat (`:452-461`) y «Abrir conversación» (`lead-drawer.tsx:160-166`)
  llevan a chats ajenos → Bandeja dice «Esta conversación la atiende otro
  vendedor o aún no existe.» (`inbox-client.tsx:55`, `:434-436`).
- «Actividad: 14:32» (`:446-450`) = último entrante (`src/server/inbox/lead-activity.ts`),
  `formatTime` en zona del NAVEGADOR (`inbox/helpers.ts:183-195`); Citas usa
  la del negocio.
- `stage-manager.tsx:165` `title={KEEP_ACTIVE_HINT}` y explicación `max-sm:hidden`
  (`:175`); «Subir/Bajar/Agregar» deshabilitados sin texto (`:147,156,224`);
  ganado/perdido sin eliminar sin motivo (`:130-133`).
- Ganar sin monto es camino admitido y probado (`scripts/e2e-capi-reintento.mjs:267-285`):
  el aviso de monto NUNCA bloquea.
- Textos: «Monto ({moneda})» (`lead-drawer.tsx:187`), «sin él, la gráfica de
  pérdidas no dice nada» (`loss-reason-dialog.tsx:41-42`).
- Datos: en cliente `lastActivityAt, amountCents, priority, stageId, stage.kind,
  conversationId`. `ConversationDto` (`src/lib/types.ts:15-87`) trae
  `assignedTo, awaitingSince, windowOpen/windowRemainingMs, aiEnabled,
  handoffAt, unreadCount`. Para chips por tarjeta hay que ampliar la ruta del
  tablero (`conversation.assigned_user_id`, `schema.ts:438`).
- Restricciones: `e2e-archivo-ui.mjs:244-245` (botón `/Gestionar etapas/`,
  etiqueta `No archivar automáticamente "Nuevo"`); `e2e-monto-pipeline`,
  `e2e-prioridad`, `e2e-roles.mjs:280-295` (API); `e2e-responsive.mjs:52,152,424`
  `/pipeline` a 390×844 sin desborde horizontal de `main` (el
  `overflow-x-auto` de `pipeline-client.tsx:191` lo evita: todo lo nuevo va
  DENTRO); panel `w-[min(360px,92vw)]`. `e2e-bitacora-etapas` es falla PREVIA.

## 2. Citas (`/bookings`, bandera AGENDA)
- `bookings-client.tsx`; vistas Semana/Día/Lista; `booking-actions.tsx`,
  `booking-dialog.tsx`, `booking-detail-panel.tsx`, `calendar/`.
- Vendedor ve suyas, creadas por él y sin asignar (`src/server/agenda/queries.ts:61-71`);
  filtro «Todas / Mías / Sin asignar» (`:572-576`). Bloqueos los crea
  cualquiera (`permissions.ts:100`) y son de todo el negocio (`service.ts:540`).
- Estados: «Cargando…» (`:630`), `cal-load-error` + «Reintentar» (`:617-628`),
  vacíos (`:722-724`, Lista `:741-744` con «Configura tu horario en Ajustes →
  Agenda» — solo Propietario). Lista corta en 200 sin aviso (`queries.ts:118`).
- Deshabilitados sin motivo: «Bloquear» (`:532`), «Guardar» del diálogo
  (`booking-dialog.tsx:271-274,697`), arrastre de pasadas/prueba/canceladas
  (`drag-model.ts:53-61`).
- Jerga: zona IANA (`:504`), «Esta cita quedó sin enlace: el proveedor no
  respondió.» (`booking-actions.tsx:98`), «reinicio del servidor» y error crudo
  de Meta (`reminder-labels.ts:69-71,95,105`), «Manual» vs «Agendó la IA»
  (`:766`), leyenda «Traslape permitido…» / «Conflicto…»
  (`calendar-legend.tsx`), «Exclusivo…» (`booking-dialog.tsx:466`), iniciales
  ocultas a lectores (`calendar/booking-block.tsx:93-97`).
- «Prueba» / «Mostrar pruebas» (`:769`, `calendar-toolbar.tsx:119`) = citas
  del Laboratorio (decisión: ocultar a vendedores).
- Lista ignora «Mostrar canceladas/pruebas» (`:489-490,747`;
  `calendar-toolbar.tsx:70`).
- Cita pasada sigue «Agendada» (`booking-look.ts:13`); nada pide el resultado.
  NO quitar «Realizada»/«No asistió» de las futuras (no está en el spec y
  rompe E2E).
- Bloqueo: sección visible al vendedor sin decir que es de todo el negocio
  (`:500-503`); «Minutos» sin validación visible (`:518-527`); sin aviso de
  éxito y se ignoran los choques que devuelve la API (`:363-371`, `route.ts:174`).
- Tooltips: `booking-block.tsx:80,86,196`, `booking-dialog.tsx:613`,
  `booking-client-card.tsx:123,158`.
- Vendedor no puede tomar una cita sin asignar: solo el Propietario reasigna
  (`booking-actions.tsx:151`).
- Datos en cliente: `scheduledAtUtc, status, kind, isTest, assignedUser,
  reminders[] (status, canRetry), linkPending, contact`; `now` (`:154`),
  `viewer.userId`, `businessTimezone`.
- Restricciones:
  - Lista: `e2e-agenda-presencial-ui.mjs:237` y `e2e-cita-cliente.mjs:161`
    buscan un `<section>` con encabezado `/^Citas/` y `ul > li`: ninguna
    sección nueva puede tener un encabezado que empiece por «Citas».
  - `booking-seller-name` solo el nombre (`e2e-agenda-presencial-ui.mjs:417`).
  - `e2e-cita-cliente.mjs`: «Cancelar cita» (`:409`), «¿Cancelar esta cita?»
    (`:421`), «No» (`:423`), grupos «Resultado» y «Cambios» (`:419`),
    «Reprogramar» (`:381,440`), «Chat asignado a X» (`:395`).
  - `e2e-agenda-calendario.mjs`: «Cita movida a» (`:514`), «Solo el
    Propietario reasigna» (`:664`), «Fuera de horario»/«Ocupado» (`:555-564`),
    `getByText("Cargando…")` (`:437`); 390×844 táctil: vista inicial Día, sin
    scroll horizontal de página; leyenda en oscuro.
  - `e2e-agenda-presencial-ui.mjs`: «Cita agendada para», «Cita reasignada.»,
    «Cita reprogramada para», «Ese vendedor ya tiene una cita a esa hora»
    (`:299,394,398,432`).
  - Conservar TODOS los `data-testid` `bookings-*`, `booking-*`, `cal-*`,
    `move-overlap-*`.
  - Unit: `calendario-arrastre.test.ts:172,183`, `calendario-modelo.test.ts:394`,
    `reminders-ui.test.ts:239-253`.
  - Ayuda: `src/lib/help/topics.ts:355-379` cita «Agendar», «Tipo de cita»,
    «Día», «Horario», «Notas», «Guardar», «Cita agendada para …»,
    «Semana/Día/Lista», «Mías», «Ocupado», «No hay horarios disponibles.»
    (`help-topics.test.ts`, `e2e-ayuda.mjs:237-240,328`).

## 3. Contactos (`/contacts`)
- `src/components/contacts/contacts-client.tsx`, `new-contact-dialog.tsx`,
  `start-conversation.tsx`. `GET /api/contacts` (`src/app/api/contacts/route.ts:16`)
  no filtra por asignación. Ficha completa en `inbox/contact-panel.tsx`.
- Sin carga/error: vacío «Sin contactos…» (`:201`) también antes de la primera
  respuesta (debounce `:138`) y si falla (`fetchPage` → null, `:89-91`).
- Archivar sin aviso (`:296-307`); `patch` no revisa `res.ok` (`:142-149`).
- «Ver archivados» (`:169`) suma archivados (`route.ts:67`).
- «Escribir primero» ícono + `title` (`:283-290`); en IG/Messenger 422
  (`start-conversation/route.ts:42-47`); ventana abierta → «window_open»
  (`:90-93`).
- Deshabilitados sin motivo: «Crear contacto» (`new-contact-dialog.tsx:226`),
  aviso de etapas que parpadea (`:214-218`), «Iniciar conversación»
  (`start-conversation.tsx:150`), «Guardar» de Editar (`contacts-client.tsx:440`).
- Jerga: `{t.name} ({t.language})` (`start-conversation.tsx:123`), «Valor de
  {{1}}» (`:139`), «Valor de la variable 1» (`:138`).
- Datos: `ContactDto.channel` (`src/lib/types.ts:369`), `phone===null`,
  `stageName, priority, archivedAt, source, total`; ventana/conversación/
  asignación NO vienen (ampliar la ruta).
- Restricciones: `e2e-contactos-paginacion.mjs` cuenta `page.locator("ul > li")`
  y «Mostrando 50 de N» (ningún `<ul>` nuevo en la página);
  `e2e-search-filters.mjs` (~367-405) `getByLabel("Buscar contacto")`,
  `getByLabel("Filtrar por etapa del embudo")`; `e2e-responsive.mjs:53`.

## 4. Catálogo (`/catalog`)
- `catalog-client.tsx`, `product-detail.tsx`, `product-dialog.tsx`,
  `categories-dialog.tsx`; `page.tsx:17` `canEdit={isOwner}`.
- Al vendedor no se le dice cómo usarlo (botón «Catálogo» / atajos
  `/fotos_<código>` en la Bandeja, `inbox/catalog-panel.tsx`); vacío
  `catalog-client.tsx:160`. «Inactivo/Inactiva» sin explicar (`:310`,
  `product-detail.tsx:286`, `:428`).
- «Crear atajos» (`product-detail.tsx:315-323`) no muestra si ya existen
  (respuesta «Ya existía /x (no se tocó)», `catalog-view.ts:214`).
- Tarjeta con conteos en `title` (`catalog-client.tsx:317-329`); «Subir
  archivos» con tope lleno solo por `title` (`:512`), contador `:483`.
- Jerga: `CODE_HINT` (`product-dialog.tsx:18`), `title` de `:311`,
  «Compartidos (todas las variantes)», «Pertenecen a» (`:491,500`),
  «Compartido» (`:749`), formatos (`:533-537`), «Vacío = hereda…»
  (`product-dialog.tsx:262`), «Un solo nivel.» (`categories-dialog.tsx:78`).
- Datos: `GET /api/quick-replies` trae `productId` y `shortcut`
  (`types.ts:274-286`); `defaultShortcutsFor(product)`; `CATALOG_LIMITS`.
- Restricciones: `e2e-catalogo.mjs:715-770` `data-testid` `catalog-product`
  (+`data-product-id`), `catalog-detail`, `catalog-upload-input` (`accept`),
  `catalog-upload` (+`data-status`), `catalog-upload-note`, regex «no puede
  convertir este formato»; además `catalog-variant`, `catalog-file`,
  `catalog-file-group`, `catalog-confirm`, `catalog-shortcut-result`;
  `catalog-view.test.ts:126-138` «Compartidos»; `us-catalogo.md:28` «Ya
  existía»; `ayuda-capturas.mjs:394-412` `getByRole("list",{name:"Productos"})`
  y `{name:"Archivos"}`.

## 5. Reportes (`/reports/*`, solo Propietario)
- Pestañas `reports-tabs.tsx:22-29`; `print-button.tsx`; bloques por separado.
- ⓘ en cada KPI: `kpi-tile.tsx:40-42` (`<span title={help}>` + Info);
  definiciones lejos: `summary-report-client.tsx:806-864`,
  `sales-report-client.tsx:650+`, `sellers-report-client.tsx:~510-540`.
- Acciones siguientes existentes: pendientes con enlaces
  (`summary-report-client.tsx:746`), «Ver detalle en Agente» / «Ver
  Vendedores» (`:304,311`), «N ventas del rango sin monto…»
  (`sales-report-client.tsx:72-88`) — modelo a imitar.
- Sin ventas: «No se ganó ni se perdió ningún lead en este rango.» (`:68`) y
  aun así todos los bloques en 0; `summaryHighlights` omite ventas si
  `won===0` (`summary-report-format.ts:233`); `funnel` (`:141-148`) sirve para
  explicar.
- Vacíos sin siguiente paso: `summary-report-client.tsx:76`,
  `agent-report-client.tsx:119`, `bookings-report-client.tsx:~127`,
  `ads-report-client.tsx:~129`, `sellers-report-client.tsx:282`.
- «Descargar PDF» deshabilitado solo con `title` (`print-button.tsx:53`);
  `range-picker.tsx:75`.
- Jerga: IANA (`range-picker.tsx:80`, `report-print.tsx:118`,
  `summary-report-client.tsx:861`), «mediana · p90» (`response-times.tsx:53,61-63`,
  `summary-report-client.tsx:520`, `agent-report-client.tsx:237`), error de
  Meta crudo (`delivery-failures.tsx:61`), «Escalamientos», «Salientes
  fallidas», «Oferta → cita», «Cartera», «Ticket», «Tasa de cierre».
- Datos: DTO por bloque (`pending`, `team.rows[].pending`, `external.notContacted`,
  `sales.wonAmount.wonWithoutAmount`, `funnel.stages[].leads`, `previous`,
  `agendaEnabled`, `intakeEnabled`).
- Restricciones: `e2e-metricas.mjs:450-510` («Reparto de atención», «Pausas
  por respuesta manual», `kpi-active`, `manual-reply-pauses`,
  `approximate-notice`, `volume-chart`, `[aria-label="Escalamientos por
  motivo"]`, grupo «Rango del reporte», «90 días»); `e2e-selftest.mjs:6000-6100`
  (`kpi-sellers-persons` `:not([aria-busy])`, `sellers-roster`/`sellers-results`
  `[data-seller]`, `kpi-summary-inbound`, `summary-team` `[data-team]`,
  `report-print-header`, `[data-highlight="bookings"]`, «Cartera y atención
  por vendedor», «Ver Vendedores», frases de `sellers-how-counted`); unit
  `reports-ui-021.test.ts:190-193,241,276,334-343`, `reports-ui.test.ts`,
  `reports-ui-024.test.ts`, `summary-report.test.ts`, `sales-report.test.ts`;
  impresión `print:` y layout sin scroll propio (`layout.tsx:20`).
