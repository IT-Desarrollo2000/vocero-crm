# 019 — Tareas (v2)

Estado durable del loop. `[x]` = hecho y verificado.

## Fase A — Catálogo local
- [x] A0 Esquema (5 tablas + columnas en `quick_reply`/`media_asset`), migración 0021 re-ejecutable, ids, contratos (`src/lib/catalog.ts`, `storage/types.ts`, firmas), storage `local` + tests de contrato
- [x] A1 Store + rutas `/api/catalog/*` (categorías, productos, variantes, archivos, servir) + permisos + respuestas rápidas ligadas a producto + tests
- [x] A2 `sendCatalogBatch` + `POST /api/conversations/[id]/messages/catalog` (copia en caché, procedencia, errores por archivo) + tests
- [x] A3 Página Catálogo (todos; edición owner), categorías, variantes, galería, subida, "Crear atajos" + NAV
- [x] A4 Compositor: chips por atajo, botón Catálogo, "Insertar detalles", incompatibles en gris, resumen · Ajustes de respuestas rápidas: producto + tipo
- [x] A5 E2E `e2e-catalogo` (AC 1–3, 5–10, 12) + gate + regresiones — 77/77; regresión selftest 353/353, respuestas-rápidas 40/40, adjuntos-ui 26/26 (BD aislada, 15-oct)

## Fase B — Reutilización
- [x] B1 `product_file_upload` + reutilización WhatsApp (25 días, re-subida única) y Messenger (Attachment Upload API) + invalidación al borrar
- [x] B2 wa-mock: `message_attachments`, contador de subidas, id inválido simulado · E2E AC 4 + sandbox sin caché — e2e-catalogo 99/99, selftest 353/353, adjuntos-ui 26/26 (15-oct)

## Fase C — Conector Azure Blob
- [x] C1 ADR-003 (almacenamiento como conector; tercera bandera)
- [x] C2 `azure-blob.ts` (SharedKey REST, cadena incl. Azurite, errores saneados) + vectores + tests de contrato · `env.ts`, `.env.example`, `.env` placeholder
- [x] C3 Ajustes: estado + "Probar conexión" (solo encendido) · Azurite en compose dev + CI
- [x] C4 E2E AC 11 (Azurite encendido/apagado) + humo con cuenta real — Azurite: local 103/103, azure-blob 115/115 (incl. caída y recuperación); cuenta real del dueño 113/113, contenedor limpio al terminar (15-oct)

## Fase D — Imágenes convertidas en el navegador (15-oct)
- [x] D1 `src/lib/image-normalize.ts` (plan puro + canvas → JPEG ≤ tope, fondo blanco, 2560 px, calidad 0.85→0.65 y escala ×0.8) + tests unitarios · catálogo (tope 5 MB, accept webp/gif/heic/heif, aviso por fila) · clip del compositor (tope del canal) · FR-950..953 / AC-13..15 — E2E BD aislada: e2e-catalogo 124/124 (f2: WebP → JPG, PNG de ruido 29.5 MB → JPEG ≤ 5 MB y lote sent, HEIC ilegible → aviso + 415), e2e-adjuntos-ui 36/36 (WebP por el clip → image/jpeg en /media, HEIC → aviso + 415)

## Cierre
- [x] Z1 Docs: `CLAUDE.md` (mapa), memoria (`upstream-migraciones` → renumerar desde 0022)
- [x] Z2 Revisión de Fable antes de declarar hecho — veredicto: hecho tras 1 corrección (compositor con key por conversación); e2e-catalogo 109/109 (y falla sin el arreglo)
