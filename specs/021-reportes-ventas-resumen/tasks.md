# 021 — Reportes: Ventas, Resumen y PDF · tareas

Plan: [plan.md](plan.md). Rama `021-reportes-ventas-resumen` (worktree
`vocero-crm-021`). `[x]` hecho y verificado · `[ ]` pendiente.

Tests que hoy afirman lo que cambia: ninguno afirma «Próximamente» ni el
redirect `/reports → /reports/agent` (grep 19-oct en reports-ui, e2e-selftest,
e2e-metricas, role-matrix). Las páginas nuevas copian `reports/ads/page.tsx`.

## Fase 0 — contratos compartidos (un solo agente)
- [x] 0.1 `SalesReportDto` + `SummaryReportDto` en `src/lib/reports.ts`; preset `today` en `REPORT_PRESET_DAYS`/parseo; matriz `permissions.ts` con `GET /api/reports/sales|summary`.

## Fase A — PDF + «Hoy»
- [x] A1. Preset `range=today` (from = to = hoy en la zona) + opción «Hoy» en `range-picker.tsx`; unit en `report-range.test.ts`.
- [x] A2. Botón «Descargar PDF» en el layout de Reportes (`window.print()`, título del documento = nombre del archivo).
- [x] A3. Hoja `@media print` (tema claro, ocultar navegación/pestañas/selector/botones, encabezado de impresión, tablas en vez de tarjetas móviles, `break-inside: avoid`, Carta).
- [x] A4. Nota D1b en Anuncios.

## Fase B — Ventas
- [x] B1. DTO `SalesReportDto` en `src/lib/reports.ts`.
- [x] B2. `src/server/reports/sales.ts` (bloques summary/byAdvisor/lossReasons/funnel/timeToClose/byDay) + unit SQL.
- [x] B3. `GET /api/reports/sales` + matriz de permisos.
- [x] B4. Página + `sales-report-client.tsx`; Ventas deja de ser `DisabledTab`.

## Fase C — Resumen
- [x] C1. DTO `SummaryReportDto`.
- [x] C2. `src/server/reports/summary.ts` (attention/byAd/byChannel/byHour/pending/sales/responseTimes) + unit SQL.
- [x] C3. `GET /api/reports/summary` + matriz. (UI hecha: `/reports` → `/reports/summary`; pestaña Resumen primera.)
- [x] C4. `summary-report-client.tsx` (KPIs con periodo anterior, tablas, barras por hora, pendientes con enlace).

## Fase D — Verificación
- [x] D1. Gate `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
- [x] D2. E2E en `scripts/e2e-selftest.mjs` (BD :5433): ventas/resumen 200 + números, vendedor 403/404, pestañas reales, 422, impresión + `page.pdf()` por pestaña. Modo apagado (AGENDA/ATRIBUCION/CHANNELS off) también verde.
- [x] D3. Contraste con datos reales (solo lectura en prod) del 16-oct. `summaryReport` 7/7 bloques ok. Por hora 00–15 idéntico al reporte manual; personas 193 = suma por anuncio (80+52+28+33). Tiempo hasta asesor: al corte 16:10 p50 17.2 min con n=109 (= manual); día completo p50 142 min (48 personas esperaron > 12 h). Ventas en 0: prod no tiene leads en «Cliente» (solo 2 eventos won, ambos reabiertos) ni montos (0/678).

## Fase E — 021b leads externos (rama `021b-reportes-por-origen`)
- [x] E1. Resumen «Por origen» (anuncios + Sitio web + FastApp + sin origen) + KPI «Leads nuevos»; DTO, SQL y unit.
- [x] E2. Resumen «Leads del formulario y FastApp» (recibidos, contactados, sin contactar, respondieron, tiempo a primer contacto) + viñeta.
- [x] E3. Ventas «Ventas por origen» por fuente efectiva; notas «Cómo se cuenta».
- [x] E4. Gate + E2E (selftest con tarjetas de lead por `POST /api/intake/lead` con la bandera de la 011 encendida y apagada) en BD/puerto PROPIOS. Selftest on 513/513, off (LEADS_EXTERNOS/AGENDA/ATRIBUCION/CHANNELS off) 279/279, e2e-metricas 83/83; PDFs de Resumen y Ventas revisados (la sección de leads externos va junta en papel).
- [x] E5. Contraste con prod (solo lectura, 19-oct): 16-oct sin regresión (193 leads = 193 personas, filas de anuncio 80/52/28, sin origen 33); hoy Sitio web 10 y FastApp 7 recibidos, 0 contactados (= consulta directa); todos los bloques ok.
