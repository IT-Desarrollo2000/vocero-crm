# 019 — Plan técnico (v2)

Fases verificables por separado: **A** catálogo local (datos, categorías,
variantes, UI, atajos, botón, envío) → **B** reutilización en Meta → **C**
conector Azure Blob (ADR-003). Cada fase cierra con gate + E2E verde.

## Modelo de datos (migración `drizzle/0021_catalogo_productos.sql`)

`pnpm db:generate` + edición a mano re-ejecutable (`IF NOT EXISTS`, FKs en
`DO $$`, sin `"public".`), estilo 0015/0020.

| Tabla | Columnas clave |
|---|---|
| `product_category` (`pcat_`) | org, name, position |
| `product` (`prd_`) | org, category_id (SET NULL), name, code, price, description, attributes jsonb, active, position |
| `product_variant` (`pvar_`) | org, product_id (CASCADE), name, code, price, attributes jsonb, active, position |
| `product_file` (`pf_`) | org, product_id (CASCADE), variant_id (CASCADE, nulo = compartido), kind, mime_type, file_name, file_size, storage_provider, storage_key, position |
| `product_file_upload` | org, product_file_id (CASCADE), channel, account_id, remote_id, uploaded_at · UNIQUE (product_file_id, channel, account_id) |
| `quick_reply` + | product_id (SET NULL), attach |
| `media_asset` + | product_file_id (SET NULL, solo procedencia) |

Unicidad de códigos entre productos y variantes: índice único parcial
`lower(code)` en cada tabla + verificación cruzada en el store dentro de la
transacción (409 `duplicate_code`).

## Contratos públicos (fase A0, un solo editor)

- `src/lib/catalog.ts`: Zod de categoría/producto/variante/atributos, DTOs
  (`CatalogDto`), `fileKindFor`, `filesForAttach`, `defaultShortcutsFor`,
  `fileCompatibility(file, outboundFiles)`, `productDetailsText(product,
  variant?)`.
- `src/server/catalog/storage/types.ts`: `CatalogStorage { provider; put(key,
  data, mime); get(key): Buffer; delete(key); test() }` + `StorageError`
  (`unavailable | not_found | misconfigured`).
- `src/server/catalog/store.ts`: firmas de CRUD y `readCatalogFile(org,
  fileId)`.
- `src/server/catalog/send.ts`: firma de `sendCatalogBatch`.

## Reparto en agentes (un dueño por archivo caliente)

| Fase | Agente | Archivos |
|---|---|---|
| A0 | code-editor | `schema.ts`, migración 0021, `ids.ts`, contratos de arriba, storage `local` |
| A1 | code-editor | `store.ts`, rutas `/api/catalog/*`, `permissions.ts` + `role-matrix.test`, `src/lib/quick-replies.ts`, `src/server/quick-replies.ts` |
| A2 | code-editor (paralelo a A1) | `send.ts` (solo lo necesario), `src/server/catalog/send.ts`, ruta `messages/catalog` |
| A3 | code-editor (tras A1) | página Catálogo + `src/components/catalog/*` + `app-nav.tsx` + `role-nav.test` |
| A4 | code-editor (tras A1/A2, paralelo a A3) | `composer.tsx` (chips, botón Catálogo), `settings/quick-replies-client.tsx` |
| A5 | sesión principal / code-editor | `scripts/e2e-catalogo.mjs`, `tests/e2e/us-catalogo.md` |
| B | code-editor | `product_file_upload`, `whatsapp/media.ts`, `messenger/send.ts`, `send.ts`, wa-mock (`message_attachments`, id inválido, contador de subidas) |
| C | code-editor | `storage/azure-blob.ts` (SharedKey REST, parseo de cadena incl. Azurite, vectores de prueba), `storage/index.ts`, `env.ts`, `.env.example`, Ajustes estado + "Probar conexión", Azurite en compose de dev y CI `completo`, ADR-003 |

## Verificación

- Gate por fase: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
- E2E en BD aislada :5433 + mocks (`.env.e2e`), extendiendo el arnés:
  fases A/B con `CATALOG_STORAGE=local`; fase C repite con `azure-blob`
  contra Azurite y con Azurite apagado (degradación).
- Regresión: `e2e-respuestas-rapidas`, `e2e-adjuntos-ui`, `e2e-selftest`.
- Humo con la cuenta real de Azure del dueño (cadena en `.env`, placeholder
  `REEMPLAZA_...`): subir, ver y borrar un archivo. Envío real a Meta queda
  como verificación humana para Messenger/IG (no hay credenciales reales).

## Riesgos

- Firma SharedKey a mano: vectores de prueba + Azurite (estricto). Plan B
  local al adaptador: SDK oficial.
- Messenger reutilizable usa otra ruta de la API (Attachment Upload): solo
  verificable con mock.
- `send.ts` es archivo caliente: solo A2 y B lo tocan, en serie.
