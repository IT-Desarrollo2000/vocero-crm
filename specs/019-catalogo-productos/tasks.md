# 019 — Tareas (v2)

Estado durable del loop. `[x]` = hecho y verificado.

## Fase A — Catálogo local
- [x] A0 Esquema (5 tablas + columnas en `quick_reply`/`media_asset`), migración 0021 re-ejecutable, ids, contratos (`src/lib/catalog.ts`, `storage/types.ts`, firmas), storage `local` + tests de contrato
- [x] A1 Store + rutas `/api/catalog/*` (categorías, productos, variantes, archivos, servir) + permisos + respuestas rápidas ligadas a producto + tests
- [x] A2 `sendCatalogBatch` + `POST /api/conversations/[id]/messages/catalog` (copia en caché, procedencia, errores por archivo) + tests
- [ ] A3 Página Catálogo (todos; edición owner), categorías, variantes, galería, subida, "Crear atajos" + NAV
- [ ] A4 Compositor: chips por atajo, botón Catálogo, "Insertar detalles", incompatibles en gris, resumen · Ajustes de respuestas rápidas: producto + tipo
- [ ] A5 E2E `e2e-catalogo` (AC 1–3, 5–10, 12) + gate + regresiones

## Fase B — Reutilización
- [ ] B1 `product_file_upload` + reutilización WhatsApp (25 días, re-subida única) y Messenger (Attachment Upload API) + invalidación al borrar
- [ ] B2 wa-mock: `message_attachments`, contador de subidas, id inválido simulado · E2E AC 4 + sandbox sin caché

## Fase C — Conector Azure Blob
- [ ] C1 ADR-003 (almacenamiento como conector; tercera bandera)
- [ ] C2 `azure-blob.ts` (SharedKey REST, cadena incl. Azurite, errores saneados) + vectores + tests de contrato · `env.ts`, `.env.example`, `.env` placeholder
- [ ] C3 Ajustes: estado + "Probar conexión" (solo encendido) · Azurite en compose dev + CI
- [ ] C4 E2E AC 11 (Azurite encendido/apagado) + humo con cuenta real

## Cierre
- [ ] Z1 Docs: `CLAUDE.md` (mapa), memoria (`upstream-migraciones` → renumerar desde 0022)
- [ ] Z2 Revisión de Fable antes de declarar hecho
