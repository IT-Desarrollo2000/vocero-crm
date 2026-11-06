# 032 — Plan técnico

Sin migración ni dependencia nueva. Cambios de API acotados (ver cada fase).
Patrones de 031 a reutilizar: chips/estado de `conversation-list.tsx`,
«lo que te toca» de `inbox-summary.tsx`, 3 pasos de `template-sender.tsx`,
`blockedReason`, lógica pura en `src/lib/*.ts` con test unitario.

## Común
- `src/lib/tz-label.ts` (puro + test): zona IANA → «hora de Ciudad de México»
  (mapa de zonas de México y LatAm comunes; respaldo: último segmento sin `_`).
  Lo usan Citas (A) y Reportes (C).
- Cada fase: textos de `/ayuda` (`src/lib/help/topics.ts`, test
  `help-topics.test.ts`, `e2e-ayuda.mjs`) y capturas
  (`scripts/ayuda-capturas.mjs` → `public/ayuda/`) al día con la UI nueva.

## Fase A — Seguimiento + Citas
### Seguimiento
- `GET /api/pipeline/board`: cada lead suma `assignedTo {id,name}|null`,
  `awaitingSince`, `lastInboundAt` / ventana (WhatsApp 24 h; IG/Messenger
  según `replyModeFor`), `channel`, y con `AGENDA` encendida su próxima cita
  visible para quien consulta (mismas reglas que `src/server/agenda/queries.ts`).
  Respuesta con `viewer {userId, role}`.
- `src/lib/pipeline-card.ts` (puro + test): estado de tarjeta → chips y acción
  principal; resumen «lo que te toca»; filtro mine/unassigned/all.
- UI `pipeline-client.tsx` (+ `lead-drawer.tsx`): filtro (localStorage,
  default por rol), franja dentro del contenedor `overflow-x-auto`, carga /
  error / fallo de mutación visibles, vacío por columna, subtítulo ganado/
  perdido, `useEvents` con refetch con rebote. «Tomar y responder» = mismo
  `assign` con `expect:"unassigned"` que el Buzón de 031 y luego
  `/inbox?contact=`. Quitar `title` de `stage-manager.tsx` (texto visible).
### Citas
- «Tomarla»: `PATCH /api/bookings/[id]` (o la acción existente de reasignar)
  acepta que un `member` se asigne a sí mismo solo si la cita no tiene vendedor
  (condición en el UPDATE; 409 con motivo si ya la tomó alguien). Matriz
  `permissions.ts` + `role-matrix.test.ts` al día.
- `src/lib/bookings-todo.ts` (puro + test): pasadas sin resultado, hoy /
  mañana, sin vendedor. Datos: `GET /api/bookings` con rango propio
  (−14 d … +2 d), aparte del rango del calendario.
- UI `bookings-client.tsx`, `calendar-legend.tsx`, `booking-block.tsx`,
  `booking-actions.tsx`, `booking-dialog.tsx`, `booking-client-card.tsx`,
  `reminder-labels.ts`: franja «lo que te toca», leyenda corta + choque dicho
  en el bloque, `tz-label`, filtros rotulados, «Mostrar pruebas» solo
  Propietario, bloqueo explicado + aviso de éxito + choques que devuelve la
  API, «pídele al propietario» para el vendedor, sin `title`.
- Conservar TODOS los `data-testid` y los textos que citan los E2E (lista en
  la auditoría: «Cancelar cita», «¿Cancelar esta cita?», «Resultado»,
  «Cambios», «Reprogramar», «Chat asignado a X», «Cita movida a», «Solo el
  Propietario reasigna», «Fuera de horario», «Ocupado», «Cargando…», etc.) o
  actualizar el guion con el cambio de comportamiento justificado.

## Fase B — Contactos
- `GET /api/contacts`: `archived=only|exclude` (filtro real) y por contacto
  `conversation {id, assignedTo, lastInboundAt, windowOpen, channel}`.
- `src/lib/contact-row.ts` (puro + test): acción por fila.
- UI `contacts-client.tsx`: segmentado Activos/Archivados, acción por fila,
  «Escribir primero» reutiliza el componente de 3 pasos de 031, aviso
  «Archivaste a X · Deshacer», carga/error ≠ vacío, motivos visibles.
  Respetar `ul > li` y «Mostrando N de M» (`e2e-contactos-paginacion`,
  `e2e-search-filters`).

## Fase C — Catálogo + Reportes
- Catálogo: `src/lib/catalog-readiness.ts` (puro + test) desde
  `product.files/price/code/active` + `/api/quick-replies` (`productId`).
  Franja «cómo mandar» y atajos con «Copiar» (vendedor); «Listo para mandar /
  Le falta» + resumen + detalle con atajos existentes (propietario). Conservar
  los `data-testid` de `e2e-catalogo`.
- Reportes: `kpi-tile.tsx` sin ⓘ/`title`, definición visible; «Lo que toca
  hoy» desde los bloques existentes; textos sin «mediana/p90»; `tz-label`;
  Ventas sin ventas → explicación + embudo + «Ir a Seguimiento». Actualizar
  unit/E2E con frases literales (`reports-ui-*.test.ts`, `e2e-metricas`,
  selftest de Vendedores).

## Verificación por fase
Gate (`pnpm typecheck && pnpm lint && pnpm build && pnpm test`) + E2E nuevo
de la fase (`scripts/e2e-modulos-<fase>.mjs` + `tests/e2e/us-*.md`) + regresión
de los guiones del módulo, en la BD aislada :5433 (`.env.e2e`,
`CATALOG_STORAGE=local`). Luego merge a main, deploy (deploy-ops) y
verificación en vivo.
