# 024 — Reportes de vendedores · tareas

Plan: [plan.md](plan.md). Rama `024-reportes-vendedores` (worktree
`vocero-crm-021`). `[x]` hecho y verificado · `[ ]` pendiente.

Afirmaciones existentes que cambian (actualizarlas, no descubrirlas en rojo):
orden de pestañas del selftest (pasa a Resumen · Agente · Citas · Ventas ·
Vendedores · Anuncios), el bucle de impresión por pestañas, `reportTabLabel`,
la comprobación «enlace real» de pestañas (copiarla para Vendedores), y
`role-matrix.test.ts` para `GET /api/reports/sellers`. Siembra de citas en
E2E: reutilizar `scripts/e2e-agenda-presencial.mjs` (horario, tipos y
marcadores del ai-mock `[e2e-agenda <tipo>]` / `[e2e-reserva <ISO>]`).
E2E en BD `vocero_e2e024` y puerto 3104 (nunca `vocero` ni :3100/:3103).

## Fase A — Vendedores
- [x] A1. DTO `SellersReportDto` + `src/server/reports/sellers.ts` (roster, sales reutilizado, bookings si AGENDA, funnel) + unit (`tests/unit/sellers-report.test.ts`). Consultas ejecutadas contra Postgres real (BD `vocero_e2e024`, siembra revertida/borrada): invariante personas/atendidas/pendientes = Resumen verificado.
- [x] A2. `GET /api/reports/sellers` + matriz de permisos.
- [x] A3. Página + pestaña «Vendedores» (entre Ventas y Anuncios) + `sellers-report-client.tsx` (pantalla, móvil, impresión). Unión de bloques pura en `sellers-report-format.ts` (`sellerResults`: roster como columna vertebral, filas null separadas «Sin asignar»/«Sin asesor»/«Sin vendedor», total por bloque) + unit `tests/unit/reports-ui-024.test.ts`. Dos tablas («Cartera y atención» y «Resultados» con ventas + citas) con scroll horizontal propio; tarjetas en móvil; en Carta caben sin scroll (PDF de 3 hojas).

## Fase B — Resumen
- B1. Bloque `team` («Equipo») + viñeta de concentración de pendientes.
  - [x] Servidor: `teamSql` (una consulta) + `shapeTeam` (tope 10 + «Otros», «Sin asignar», `totals`, `topPending`) + unit + Postgres real.
  - [x] UI: tabla «Equipo» (`data-testid=summary-team`), enlace «Ver Vendedores» solo en pantalla, viñeta `team-pending` (≥ 3 pendientes y ≥ 40 %).
- B2. Bloque/KPI de citas del periodo (si AGENDA).
  - [x] Servidor: `bookings` = `attendanceSql` de Citas (+ `total`, `scheduled`), `null` sin AGENDA; `agendaEnabled` en el DTO.
  - [x] UI: viñeta `bookings` en «Lectura rápida» (solo con AGENDA y alguna cita).

## Fase C — Citas
- [x] C1. Bloques por tipo, por vendedor y citas → ventas en `bookings.ts` + DTO + unit (ejecutados contra Postgres real).
- [x] C2. UI en `bookings-report-client.tsx`: «Por tipo de cita», «Por vendedor» (Manual · IA) y «Citas que terminaron en venta» («ganado al momento de generar el reporte»).

## Fase D — Verificación
- [x] D1. Gate `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (157 archivos, 2035 tests).
- [x] D2. Selftest en BD/puerto propios (encendido y apagado) + métricas + agenda presencial; PDFs de Vendedores, Resumen y Citas. Bloque 024 en `scripts/e2e-selftest.mjs` (`reportesVendedoresChecks`). BD `vocero_e2e024` + :3104: selftest on 588/588, off 329/329, `e2e-metricas` 83 verde, `e2e-agenda-presencial` 152/0.
- [x] D3. Contraste con prod (solo lectura, 21-oct, últimos 7 días): todos los bloques ok; INVARIANTE exacto (Resumen 907 personas / 786 atendidas / 94 pendientes = suma del roster); 10 miembros en el roster (5 en cero, incl. «Revisor Meta»); Sin asignar 638 personas y los 17 externos sin contactar; citas en 0 (4 tipos + Sin tipo).
