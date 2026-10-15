# 019 — Plan técnico

## Modelo de datos (migración `drizzle/0021_catalogo_productos.sql`)

Generada con `pnpm db:generate` y editada a mano para ser re-ejecutable
(`IF NOT EXISTS`, constraints en `DO $$`, sin `"public".`), como 0015/0020.

```sql
CREATE TABLE IF NOT EXISTS "product" (
  "id" text PRIMARY KEY,                       -- prd_
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "code" text,                                 -- p. ej. T03
  "price" text,
  "description" text,
  "active" boolean NOT NULL DEFAULT true,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_org_code_uq"
  ON "product" ("organization_id", lower("code")) WHERE "code" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "product_org_pos_idx" ON "product" ("organization_id", "position");

CREATE TABLE IF NOT EXISTS "product_file" (
  "id" text PRIMARY KEY,                       -- pf_
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "product_id" text NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,                        -- image | document
  "mime_type" text NOT NULL,                   -- detectado por firma
  "file_name" text NOT NULL,
  "file_size" integer NOT NULL,
  "storage_path" text NOT NULL,                -- {org}/catalog/{id}
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "product_file_product_idx" ON "product_file" ("organization_id", "product_id", "position");

ALTER TABLE "quick_reply" ADD COLUMN IF NOT EXISTS "product_id" text;   -- FK ON DELETE SET NULL (DO $$)
ALTER TABLE "quick_reply" ADD COLUMN IF NOT EXISTS "attach" text;       -- images | documents | all
```

Ids: `prd` y `pf` en `src/lib/db/ids.ts`.

## Mapa de cambios

| Capa | Archivo | Cambio |
|---|---|---|
| Esquema | `src/lib/db/schema.ts` | `product`, `productFile`; `quickReply.productId/attach` |
| Lógica pura | `src/lib/catalog.ts` (nuevo) | Zod de producto, límites, `fileKindFor(inspection)`, `defaultShortcutsFor(code)`, `filesForAttach(files, attach)`, `fileCompatibility(file, outboundFiles)` (usado por el compositor) |
| Persistencia | `src/server/catalog/store.ts` (nuevo) | CRUD de productos/archivos con `scoped()`; `CatalogError(status, code)`; disco en `src/server/catalog/files.ts` (`catalogFilePath`, `saveCatalogFile`, `readCatalogFile`, `removeCatalogFiles`) |
| Envío | `src/server/catalog/send.ts` (nuevo) | `sendCatalogBatch({ conversationId, organizationId, text?, fileIds })` → `sendText` + `sendMediaMessage` secuencial; clasifica errores por archivo (FR-923) |
| API | `src/app/api/catalog/route.ts` (GET any, POST owner) · `catalog/[id]/route.ts` (PATCH/DELETE owner) · `catalog/[id]/files/route.ts` (POST owner, multipart) · `catalog/files/[fileId]/route.ts` (GET any, DELETE owner) · `conversations/[id]/messages/catalog/route.ts` (POST any*, visibilidad + `gateSend`) | |
| Permisos | `src/lib/permissions.ts` | Clasificar las rutas nuevas (`role-matrix.test.ts`) |
| Respuestas rápidas | `src/lib/quick-replies.ts`, `src/server/quick-replies.ts` | `productId`/`attach` en Zod (refine: ambos o ninguno; body opcional con producto), var `{{producto}}`, GET resuelve producto + archivos filtrados; matching sin mayúsculas |
| UI Catálogo | `src/app/(app)/catalog/page.tsx` + `src/components/catalog/*` | Lista de productos (tarjetas con portada), detalle/edición (owner), subida de archivos, galería, "Crear atajos"; Vendedor solo lectura. Ítem "Catálogo" en `NAV` (`app-nav.tsx`) para todos + `role-nav.test.ts` |
| UI Ajustes | `src/components/settings/quick-replies-client.tsx` | Selector de producto + "Enviar: Fotos / Documentos / Todo"; marca "Sin producto" |
| Compositor | `src/components/inbox/composer.tsx` (+ componente de chips) | Escenificar archivos al elegir respuesta ligada; chips removibles e incompatibles en gris; enviar lote; resumen |
| E2E | `scripts/e2e-catalogo.mjs` + `tests/e2e/us-catalogo.md` | AC-1…AC-9 contra app real + mocks |
| Docs | `CLAUDE.md` (mapa) | Fila "Catálogo" |

## Riesgos

- **Purga**: verificada por AC-6 (el catálogo no usa `media_asset`).
- **Reclamo del vendedor**: `gateSend` una vez por lote, antes de `sendText`.
- **Orden de envío**: secuencial con `await`; los mensajes quedan en orden de
  `created_at`.
- **Tamaño de la petición**: el lote es JSON con ids; los bytes se leen del
  disco del servidor (sin re-subir desde el navegador).
