# 020 — Origen de leads · tareas

Plan: [plan.md](plan.md). Rama `020-origen-de-leads` (worktree
`vocero-crm-020`). `[x]` hecho y verificado · `[ ]` pendiente.

## Fase A — captura, tarjeta, fuente y filtros (2026-10-16)

### A1. Migración 0022
- [x] `ad_attribution.image_asset_id` (FK a `media_asset`, `on delete set null`)
  + índice `(organization_id, source_id)` en `src/lib/db/schema.ts`.
- [x] `pnpm db:generate --name anuncio_de_origen`; SQL editado a mano para ser
  re-ejecutable y sin `"public"` (estilo 0020/0021). Re-ejecutada sobre la BD
  E2E sin error; `migrate.mjs` la aplica ("0 FK desqualificadas").

### A2. Captura sin bandera
- [x] `src/server/attribution/referral.ts` — `AnuncioDeOrigen` + normalizador
  de WhatsApp (lista blanca, topes, solo http(s)); mapeo de Messenger/IG
  documentado para la fase C.
- [x] `ingest.ts`: el anuncio se guarda siempre; `anuncioParaGuardar` quita el
  `ctwa_clid` (columna y `raw`) sin `ATRIBUCION`. Docstring de `flag.ts`.
- [x] First-touch por `ON CONFLICT DO NOTHING` (sin cambios de 016).

### A3. Miniatura
- [x] `src/server/attribution/creativo.ts` (hosts de Meta, https, ≤3
  redirecciones revalidadas, 5 s, 1 reintento, ≤300 KB, firma por
  `inspectFile`; mock solo con mocks activos).
- [x] Guardada como `media_asset` con `saveMediaFile`; una por `source_id`.
- [x] Reparación perezosa (`repararImagenSiFalta`) con freno.
- [x] Purga de 30 días: `purgeableCondition` excluye las referenciadas.
- [x] `/api/media/[assetId]`: visible al Vendedor si ve la conversación (D4).

### A4. API / DTO
- [x] `GET /api/contacts/[id]` → `anuncio` (`AnuncioDto`, `hasCtwaClid` sin valor).
- [x] `ConversationDto.anuncio {headline, sourceType}` en lista, `?ids=` (SSE)
  y PATCH de conversación.

### A5. UI
- [x] `src/components/anuncio-origen.tsx` (tarjeta + etiqueta de fila).
- [x] Panel del contacto (entre etapa y Ficha) y cajón del trato.
- [x] Etiqueta "Anuncio · <titular>" / "Publicación · …" en la fila.

### A6. Fuente del contacto (D3)
- [x] `effectiveSource(stored, llegoPorAnuncio)` (no deduce con publicación).
- [x] `PATCH /api/contacts/[id]` acepta `source` (Zod, enum o `null`); ruta ya
  clasificada `any` en `src/lib/permissions.ts`.
- [x] Selector "Fuente" (capturada / deducida) en el panel del contacto.
- [x] Lista de contactos deduce en lote.

### A7. Rediseño de filtros (4.4)
- [x] `list-query.ts`: vista + `origin`, `unassigned`, `closing`; compat
  `filter=unassigned|closing`.
- [x] `queries.ts`: filtros combinables + contadores facetados (+ `origin`).
- [x] `/api/conversations/counts` recibe vista y filtros del panel.
- [x] `list-state.ts` / `helpers.ts` (espejo), `use-inbox-list.ts` (URL),
  `conversation-list.tsx` (vistas, botón Filtros con número, etiquetas
  removibles, Limpiar, panel/hoja inferior).
- [x] Semántica de contadores documentada (plan §8.3, `src/lib/types.ts`).

### A8. Pruebas
- [x] Unit: `tests/unit/anuncio-origen.test.ts` (normalizador, URLs de
  creativo, descarga y firma, freno, serializador, fuente, etiquetas,
  exclusión de purga); `inbox-list-state` (URL, combinaciones, facetas);
  `inbox-query` (parseo y compat); `inbox-list` (SQL facetado).
- [x] `scripts/e2e-selftest.mjs` (`anuncioOrigenChecks`, ambas posiciones de la
  bandera; miniatura no purgada en `adjuntosChecks`).
- [x] `e2e-search-filters`, `e2e-bandeja-paginacion`, `e2e-responsive`,
  `e2e-alertas` actualizados y verdes.
- [x] Gate `pnpm typecheck && pnpm lint && pnpm build && pnpm test` verde.

### Abierto tras la fase A
- [ ] Deducción de la fuente en el contexto del agente y en `/api/bot/context`
  (hoy solo la capturada).
- [ ] Verificación real con un clic de anuncio CTWA (no hay eventos de prueba).
- [ ] Desplegar (con autorización del dueño).

## Fase B — Reportes → Anuncios
- [ ] Por fuente y por anuncio (leads, ganados, %, monto), solo Propietario.

## Fase C — Messenger e Instagram
- [ ] `anuncioDeMessenger` / `anuncioDeInstagram` + suscripciones.
