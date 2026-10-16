# E2E — Origen de leads, fase A (020)

Guion de comportamiento observable. Automatizado en `anuncioOrigenChecks` de
`scripts/e2e-selftest.mjs` (corre con `ATRIBUCION` apagada **y** encendida) y,
para la pantalla, en `scripts/e2e-search-filters.mjs`,
`scripts/e2e-bandeja-paginacion.mjs`, `scripts/e2e-responsive.mjs` y
`scripts/e2e-alertas.mjs`.

**Preparación**: app en `localhost` con `WA_MOCK_ENABLED=true` y la BD
migrada (0022). El wa-mock simula el referral con `ctwaClid`, `adHeadline`,
`adSourceId`, `adSourceType` (`ad`/`post`), `adMediaType` y `adThumbnailUrl`
(apunta a su CDN, `/api/dev/wa-mock/cdn/<id>`). `GET /api/dev/attribution?contact=`
dice qué se guardó (booleanos, nunca el valor del clic).

---

## US1 — El anuncio de origen se guarda siempre

1. Un lead escribe desde un anuncio (con `ctwa_clid` y miniatura). Con la
   bandera **apagada o encendida**, `GET /api/contacts/:id` trae `anuncio`
   (ID, titular, texto, tipo de medio, fecha, "Ver anuncio" https).
2. Apagada: `hasCtwaClid=false` y la inspección dice que el `ctwa_clid` **no**
   está ni en la columna ni en el `raw`. Encendida: está en los dos y
   `hasCtwaClid=true`. El valor jamás aparece en ninguna respuesta.
3. Un segundo referral en la misma conversación no pisa al primero (D1).

## US2 — La miniatura se copia una vez y no se purga

1. La miniatura aparece como `/api/media/<id>` y se sirve como imagen.
2. Otro lead del MISMO anuncio reutiliza la misma miniatura.
3. Una miniatura fuera de los hosts de Meta no se descarga: la tarjeta sale
   igual, sin imagen.
4. `POST /api/dev/media/purge {advanceDays: 31}` expira los adjuntos, pero la
   miniatura sigue sirviéndose (200).
5. El Vendedor ve la miniatura de una conversación que ve; la de una ajena → 404.

## US3 — La Bandeja lo enseña y lo filtra

1. La fila trae `anuncio {headline, sourceType}` (también por `?ids=`, lo que
   la Bandeja pide tras el SSE): "Anuncio · <titular>", o "Publicación · …".
2. Filtro Origen: "De anuncio" deja solo las de anuncio (no publicaciones);
   "De publicación", las de `source_type=post` (deducen «Contenido orgánico»); "Sin origen", el resto. Sus contadores cuadran.
3. Combinado con una vista y una etapa (No leídas + De anuncio + Etapa), la
   lista y los contadores facetados coinciden.
4. Panel "Filtros": número de activos, etiquetas removibles, "Limpiar" (deja
   la vista), estado en la URL que sobrevive a recargar, hoja inferior en el
   teléfono.

## US4 — Fuente del contacto (D3)

1. Sin captura y con anuncio: fuente "Anuncio", **deducida**. Con publicación:
   "Contenido orgánico", **deducida**.
2. `PATCH {source: "referido"}` → capturada, y manda sobre el anuncio.
3. `PATCH {source: null}` → vuelve a la deducida. Un valor fuera del catálogo → 422.

## US5 — Reportes → Anuncios (fase B, solo Propietario)

Automatizado en `scripts/e2e-selftest.mjs` (`reporteAnunciosChecks`,
`reporteAnunciosLabChecks`, `reporteAnunciosVendedorChecks`), con la bandera
`ATRIBUCION` en cualquier posición. Semántica: plan §8.5.

1. Línea base de `GET /api/reports/ads?range=7d`: 200, los tres bloques ok y
   las seis fuentes en orden.
2. Sembrar 3 leads del anuncio X (con miniatura, video), 2 del anuncio Y, 1 de
   una publicación y 2 orgánicos. A Ganado: X1 con 1,500.00 MXN, X2 sin
   monto, Y1 con 50.00 USD, la publicación con 300.00 y un orgánico con 100.00.
3. Por anuncio (exacto): X = 3 leads, 2 ventas, 67 %, 1,500.00 y "1 venta sin
   monto", miniatura servible; Y = 2, 1, 50 %, 0 en MXN y 50.00 USD aparte;
   la publicación con su fila tipo «Publicación»; orden X > Y > publicación;
   una sola fila por `source_id`.
4. Por fuente (delta): Anuncio +5/+5/+3/+1,500.00 (+1 sin monto, +50.00 USD
   aparte); Contenido orgánico +1/+1/+1/+300.00; Sin identificar
   +2/+2/+1/+100.00; el resto sin cambios.
5. Resumen (delta): +8 conversaciones, +5 de anuncio, +5 leads, +3 ventas,
   +1,500.00; igual a la fila Anuncio; trae el rango previo.
6. Rango sin datos (2020-01-01 → 07): 200 con bloques vacíos. Rango invertido
   → 422. `/reports/ads` responde y la pestaña es un enlace real.
7. Correr el Laboratorio no cambia Por fuente ni el resumen.
8. Vendedor: API → 403 `forbidden`; `/reports/ads` → 404.
