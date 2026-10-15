# 019 — Tareas

Estado durable del loop. `[x]` = hecho y verificado.

## Bloque 1 — Datos, servidor y API
- [ ] T001 Esquema `product` / `product_file` + `quick_reply.product_id/attach`; ids `prd`/`pf`; migración 0021 re-ejecutable (journal + snapshot)
- [ ] T002 `src/lib/catalog.ts`: Zod, límites, `fileKindFor`, `filesForAttach`, `defaultShortcutsFor`, `fileCompatibility` + tests unitarios
- [ ] T003 `src/server/catalog/files.ts` + `store.ts`: CRUD con `scoped()`, disco `MEDIA_DIR/{org}/catalog/`, borrado de disco al borrar
- [ ] T004 Rutas `/api/catalog*` (GET any, escritura owner, subida multipart con `inspectOutgoing` + precorte 413, servir con cabeceras seguras) + `permissions.ts`
- [ ] T005 Respuestas rápidas: Zod (producto+attach, body opcional, `{{producto}}`), GET con producto y archivos filtrados, búsqueda sin mayúsculas + tests
- [ ] T006 `sendCatalogBatch` + `POST /api/conversations/[id]/messages/catalog` (visibilidad, un `gateSend`, secuencial, resultado por archivo, errores que detienen el lote) + tests unitarios

## Bloque 2 — UI
- [ ] T010 Página `Catálogo` (todos los roles; edición solo owner) + ítem en `NAV` + `role-nav.test.ts`
- [ ] T011 Subida/borrado de archivos, galería, "Crear atajos"
- [ ] T012 Ajustes → Respuestas rápidas: ligar producto + tipo; "Sin producto"
- [ ] T013 Compositor: chips escenificados, incompatibles en gris, envío de lote y resumen

## Bloque 3 — Verificación y cierre
- [ ] T020 `scripts/e2e-catalogo.mjs` + `tests/e2e/us-catalogo.md` (AC-1…AC-9) en BD aislada :5433
- [ ] T021 Gate: typecheck + lint + build + test; regresión `e2e-respuestas-rapidas` y `e2e-selftest`
- [ ] T022 Docs: `CLAUDE.md` (mapa); memoria `upstream-migraciones` (ahora renumerar desde 0022)
- [ ] T023 Revisión del asesor antes de declarar hecho
