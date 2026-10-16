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
   "Sin anuncio", el resto. Sus contadores cuadran.
3. Combinado con una vista y una etapa (No leídas + De anuncio + Etapa), la
   lista y los contadores facetados coinciden.
4. Panel "Filtros": número de activos, etiquetas removibles, "Limpiar" (deja
   la vista), estado en la URL que sobrevive a recargar, hoja inferior en el
   teléfono.

## US4 — Fuente del contacto (D3)

1. Sin captura y con anuncio: fuente "Anuncio", **deducida**. Con publicación:
   "Sin identificar".
2. `PATCH {source: "referido"}` → capturada, y manda sobre el anuncio.
3. `PATCH {source: null}` → vuelve a la deducida. Un valor fuera del catálogo → 422.
