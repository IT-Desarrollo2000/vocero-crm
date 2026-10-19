# 021 — Reportes: Ventas, Resumen para dirección y PDF

Rama `021-reportes-ventas-resumen` (worktree `vocero-crm-021`), desde `main`
4a6d5c6. **Sin migración** (todo sale de tablas existentes). Solo Propietario.

## 1. Objetivo

El dueño entrega a dirección reportes del CRM. Hoy Reportes tiene Agente,
Citas (con `AGENDA`) y Anuncios; «Ventas» está como pestaña deshabilitada y no
hay forma de exportar. Esta feature agrega:

1. **Pestaña Ventas** — ventas cerradas en el periodo, monto, perdidas y
   motivos, por asesor, embudo y tiempo de cierre.
2. **Pestaña Resumen** (primera pestaña) — tablero ejecutivo para dirección:
   atención (mensajes, personas, contestadas, atendidas por asesor, tiempos),
   origen por anuncio, canal, hora, pendientes sin respuesta y ventas.
3. **Descargar PDF** en TODAS las pestañas — `window.print()` + `@media print`
   (sin dependencias nuevas, sin cambios en la imagen Docker).
4. **Preset «Hoy»** en el selector de rango.

Fuera de alcance: ligar leads al catálogo (ventas por modelo), PDF generado en
servidor, envío programado por correo (la constitución II lo prohíbe en el
núcleo), cambiar la semántica de Anuncios.

## 2. Decisiones del dueño (2026-10-19)

| # | Decisión |
|---|---|
| D1 | Una venta cuenta en el periodo por la **fecha en que el lead pasó a Ganado** (evento `won` de `lead_stage_event`), no por la fecha de llegada del lead. |
| D1b | **Anuncios conserva su definición** (cohorte por llegada, ganado = hoy en `won`) y muestra una nota que explica la diferencia con Ventas. |
| D2 | La venta se atribuye a **quien movió el lead a Ganado** (`actor_user_id`); si lo movió el bot/sistema (NULL), al **asesor asignado** a la conversación real del contacto; si no hay, «Sin asesor». |
| D3 | PDF **desde el navegador** (impresión). |
| D4 | Pestaña **Resumen** con información relevante para dirección. |
| D5 | Solo métricas posibles con los datos actuales; **sin catálogo**. |

## 3. Semántica (fuente de verdad; se copia a los docstrings y a la UI)

Común: rango `[fromUtc, toUtc)` de `parseReportRange` (zona de
`reportTimezone`); Laboratorio excluido (contacto de Laboratorio = todas sus
conversaciones `is_test`, misma regla `notLabContact` de `ads.ts`; mensajes de
conversaciones `is_test` fuera). Reglas SQL vigentes: `scoped()`, límites
`::timestamp` como texto, nada de `now()`.

### 3.1 Ventas

- **Venta** = lead que **hoy está en una etapa `won`**, con fecha de venta =
  `occurred_at` de su **último** evento `to_stage_kind = 'won'`. Cuenta en el
  periodo si esa fecha cae en el rango. Un lead ganado y luego reabierto o
  perdido deja de ser venta (no se cuentan ventas «deshechas»). **Consecuencia
  que la UI explica en «Cómo se cuenta»**: el reporte de un mes pasado puede
  cambiar si después se reabre uno de sus leads. Lead en `won` sin ningún
  evento `won` (anomalía; 0013 sembró uno por lead) NO entra a ningún periodo
  y se reporta en `withoutDate` con nota (no se usa `updated_at`: se mueve con
  cualquier edición).
- **Perdida** = lead que hoy está en `lost`, fecha = último evento `lost`;
  motivo = `loss_reason` de ese evento (`LOSS_REASON_LABEL`).
- **Tasa de cierre** = ganadas / (ganadas + perdidas) del periodo; `null` si 0.
- **Monto** = `amount_cents` de las ventas por moneda, con el `WonAmountDto`
  existente (moneda del negocio como principal, otras aparte, nunca sumadas;
  `wonWithoutAmount`). **Ticket promedio** = monto principal / ventas con
  monto en esa moneda.
- **Fechas aproximadas**: eventos `approximate = true` (sembrados por la
  migración) cuentan y se reporta cuántos hay (`approximateCount`) con nota.
- **Asesor (D2)**: `actor_user_id` del evento; si NULL → `assigned_user_id`
  de la conversación real (`is_test = false`) más reciente del contacto; si
  NULL → «Sin asesor». Nombre desde `user.name` (fallback email). La misma
  regla para perdidas, con su evento `lost`.
- **Tiempo de cierre** = fecha de venta − fecha de llegada del lead (primer
  anuncio de origen si tiene, si no `lead.created_at`); mediana y p75 en días.
- **Embudo (foto actual, no depende del rango)** = leads no-Laboratorio por
  etapa (orden `position`), con conteo y monto abierto por moneda principal.
  La UI lo dice: «Estado al momento de generar el reporte».
- **Por día** = ventas y monto (moneda principal) por día local del rango.
- **Periodo anterior** (`previousRange`) solo para el resumen.

Bloques de `GET /api/reports/sales`: `summary` (con `previous`), `byAdvisor`,
`lossReasons`, `funnel`, `timeToClose`, `byDay`.

### 3.2 Resumen (dirección)

Unidad = **persona** = conversación real con ≥1 mensaje entrante en el rango.

- **Mensajes recibidos** = entrantes en el rango. **Enviados** = salientes en
  el rango, desglosados IA (`origin='ai'`) / asesor (`operator`,`manual`) /
  plantilla.
- **Personas**, **nuevas** (contacto creado en el rango).
- **Contestada** = recibió cualquier saliente posterior a su primer entrante
  del rango. **Atendida por asesor** = recibió un saliente `operator`/`manual`
  posterior a ese primer entrante. **Pasadas a asesor** = `handoff_at` en el
  rango.
- **Tiempos de primera respuesta**: se REUTILIZA el bloque de Agente
  (definición por sesión, 24 h) para no tener dos definiciones del mismo
  número; la UI enlaza a Agente.
- **Por anuncio** = personas agrupadas por el primer anuncio del contacto
  (`source_id`, titular; varios anuncios pueden compartir titular → se
  distinguen por id), y «Sin anuncio identificado» (incluye orgánico,
  clientes previos e IG/Messenger sin dato). Columnas: personas, nuevas,
  mensajes, contestadas, atendidas por asesor, **ventas del periodo** (regla
  3.1, por el primer anuncio del lead) y monto principal.
- **Por canal**: personas, mensajes, contestadas, atendidas.
- **Por hora** = entrantes por hora local (0–23), sumando los días del rango.
- **Pendientes de respuesta** = personas del rango cuyo **último mensaje es
  entrante** y no tienen saliente posterior (al momento de generar).
  Máximo 20 filas: hora de llegada, canal, anuncio, nombre del contacto y
  enlace a la conversación (en pantalla; en el PDF sin enlace). Total aparte.
- **Ventas**: resumen de 3.1 (ganadas, monto, tasa, ticket) con periodo
  anterior.
- **Periodo anterior** para KPIs principales (mensajes, personas, contestadas
  %, atendidas %, ventas, monto).

Bloques de `GET /api/reports/summary`: `attention` (KPIs + previous),
`byAd`, `byChannel`, `byHour`, `pending`, `sales` (reutiliza la función de
summary de Ventas), `responseTimes` (reutiliza Agente).

### 3.3 Ajustes al implementar (aceptados 2026-10-19)

- «Pasadas a asesor» sale de la bitácora `conversation_handoff_event`
  (`kind='opened'`, sin `manual_reply`, como Agente) y no de `handoff_at`,
  que se limpia al volver a la IA y haría que un periodo cerrado pierda
  escalamientos.
- Tiempo de cierre excluye eventos `approximate` (se informan aparte) y una
  llegada posterior a la venta cuenta como 0 días.
- Salientes `failed` no cuentan como enviados ni como respuesta (igual que
  Agente). Pendientes: primero los que más llevan esperando.
- Perdidas sembradas sin motivo → «Sin motivo registrado».
- Ticket promedio = monto principal ÷ ventas con monto en la moneda principal.

## 4. Diseño técnico

- `src/server/reports/sales.ts` y `src/server/reports/summary.ts`, mismo marco
  que `ads.ts`: funciones `...Sql(p)` exportadas (testeables sobre el SQL
  renderizado) + `salesReport()` / `summaryReport()` con `runBlocks` +
  `runReadOnly`. Reutilizar `firstOriginCte`/`notLabContact` (extraer a un
  módulo común si hace falta, sin cambiar Anuncios).
- DTOs en `src/lib/reports.ts` (`SalesReportDto`, `SummaryReportDto`).
- Rutas `src/app/api/reports/sales/route.ts` y `.../summary/route.ts`, copia
  de `ads/route.ts`; matriz `src/lib/permissions.ts` → `"owner"`.
- Páginas `src/app/(app)/(owner)/reports/{sales,summary}/page.tsx`;
  `/reports` redirige a `/reports/summary`. Pestañas: **Resumen · Agente ·
  Citas · Ventas · Anuncios** (Ventas deja de ser `DisabledTab`).
- Clientes `sales-report-client.tsx`, `summary-report-client.tsx` con las
  piezas existentes (`KpiTile`, `ReportSection`, `format.ts`, tablas con
  tarjetas en móvil como Anuncios). Gráficos: SVG a mano como
  `volume-chart.tsx` (barras por hora, ventas por día).
- Nota D1b en Anuncios (texto bajo «Ventas de anuncio»).
- **Preset «Hoy»**: `range=today` → `from = to = hoy` en la zona del reporte.
- **PDF**: botón «Descargar PDF» en el encabezado del layout de Reportes →
  `window.print()`. **Contenedores con scroll**: `app-shell.tsx:78` es
  `h-dvh overflow-hidden` y el layout de Reportes `h-full overflow-y-auto`; un
  ancestro con scroll imprime solo su viewport (PDF truncado a una hoja), así
  que en impresión TODA la cadena html/body → shell → main → layout va con
  `height:auto; overflow:visible` (variante `print:` de Tailwind donde se
  pueda). Mostrar/ocultar con `print:hidden` / `hidden print:block`; el
  bloque `@media print` en CSS global queda para el override de variables de
  tema a claro y `print-color-adjust: exact`. Ocultar navegación de la app,
  pestañas, selector y botones;
  mostrar encabezado de impresión (negocio, pestaña, rango, zona, «generado el
  … a las HH:MM»); en impresión se muestran las tablas y se ocultan las
  tarjetas móviles; `break-inside: avoid` en secciones; tamaño Carta. El
  título del documento durante la impresión = `Reporte <pestaña> <rango>` (el
  nombre sugerido del archivo PDF).

## 5. Verificación

- Unit: SQL de ventas/resumen (scoped, `::timestamp`, sin `now()`, regla D2),
  plegado de DTOs, preset «Hoy», matriz de permisos.
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
- E2E (BD aislada :5433, mocks): sembrar ganadas/perdidas moviendo leads por
  la API como dueño y como bot; `GET /api/reports/sales|summary` 200 con todos
  los bloques y números esperados; Vendedor 403/404; pestañas enlaces reales;
  rango inválido 422; un bloque que falla pinta «No disponible»; impresión:
  `emulateMedia('print')` oculta navegación y muestra el encabezado, y
  `page.pdf()` genera un PDF de cada pestaña (evidencia).
- Prueba con datos reales: leer la BD de producción en solo lectura y comparar
  Resumen de un día contra el reporte manual del 16-oct.
