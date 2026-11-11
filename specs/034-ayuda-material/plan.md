# 034 — Plan

Contrato: [spec.md](spec.md) · diseños aprobados en [diseno/](diseno/).

## Decisiones

- **Sin bandera.** Tabla propia `training_asset`; sin filas, la Ayuda se pinta
  igual que hoy (sin recuadro, sin «Con video», capturas de ejemplo).
- **Almacenamiento.** El del catálogo (ADR-003): `getCatalogStorage()` para lo
  nuevo, `getCatalogStorage(row.storageProvider)` para lo guardado. La clave se
  generaliza a `{org}/{espacio}/{id}`, `espacio ∈ {catalog, capacitacion}`
  (`assertStorageKey`; `assertCatalogKey` queda como alias y toda clave vieja
  sigue valiendo). El contrato suma `stat(key) → { size }` y
  `getRange(key, start, end)` (fin inclusivo; quien llama ya lo validó contra
  `stat`). Local: `fs.stat` + lectura parcial con `fs.open().read()`. Azure:
  HEAD (`content-length`) y GET con `Range` (ya en el string-to-sign), exige
  206. El PUT a Azure escala su timeout con el tamaño (un MP4 de 100 MB no cabe
  en 30 s).
- **Range** (`parseByteRange`, pura, `src/lib/training.ts`): `bytes=a-b`,
  `bytes=a-`, `bytes=-n`; fin > tamaño se recorta; inicio ≥ tamaño → 416 con
  `Content-Range: bytes */size`; sintaxis rara o varios rangos → se ignora y va
  200 completo. Cada 206 se topa a 8 MiB (el navegador pide el resto).
  Se aplica a TODO tipo; sin `Range` → 200 con `Accept-Ranges: bytes`.
- **Al servir no se re-inspecciona**: cada fila se inspeccionó por firma al
  subir (a diferencia de los adjuntos previos a 018) y un rango a media pista
  no tiene firma. Se sirve con el MIME guardado y las cabeceras de
  `safeFileHeaders`; PDF como `attachment` con nombre `«título».pdf`, video e
  imagen inline; `Cache-Control: private, max-age=86400` (un id nunca cambia de
  bytes: reemplazar = fila nueva).
- **Tipos y topes por firma** (`inspectFile` de 018): documento = `application/pdf`
  ≤ 25 MB; video = `video/mp4` ≤ 100 MB; imagen de tema = PNG/JPEG/WebP ≤ 5 MB.
- **Imagen propia de un tema**: una por tema (índice único parcial). Reemplaza
  TODA la figura del tema, también en los que traen dos capturas de ejemplo
  (`catalogo`, `citas`, `ventana-24h`). Ancho/alto los lee el navegador al subir
  (`naturalWidth/Height`); sin ellos se pinta con `<img>` sin dimensiones.
- **Duración del video**: la lee el navegador al subir (`loadedmetadata`) y viaja
  en el formulario; si falta, `null` y se muestra sin duración.
- **Temas ocultos** (p. ej. `citas` con `AGENDA` apagada): el video sigue en el
  recuadro, pero sin enlace «En la guía» ni etiqueta «Con video».
- **Diseño de los temas**: se conserva el artículo de hoy (pasos arriba, figura
  después). En los temas con video la figura lleva el selector «Imagen | Video ·
  m:ss» (Video activo, como en el diseño); los demás quedan idénticos.
- **DTO** de `GET /api/training`: id, kind, title, topicId, position, sizeBytes,
  durationSeconds, mimeType y width/height solo en imágenes. Nunca
  `storage_key` ni `storage_provider`.
- **Purga de 30 días**: no la toca (solo recorre `media_asset`).

## Rutas (todas en `src/lib/permissions.ts`)

| Ruta | Rol |
|---|---|
| `GET /api/training` | any |
| `POST /api/training` (multipart: file, kind, title?, topicId?, durationSeconds?, width?, height?, replaceId?) | owner |
| `PATCH /api/training/[id]` · `DELETE /api/training/[id]` | owner |
| `POST /api/training/reorder` | owner |
| `GET /api/training/[id]/file` | any |

## Pruebas

Unit: contrato ampliado (local; Azure si hay Azurite), `parseByteRange`,
validación de tema/DTO. E2E: `scripts/e2e-ayuda-material.mjs` (Edge por H.264)
+ sección `ayudaMaterialChecks` en el self-test.
