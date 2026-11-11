# 034 — Ayuda con material de capacitación

**Origen**: capacitación de ventas (nov-2026). El dueño pidió integrar los videos
y un botón para descargar el PDF en la Ayuda, sin perder la guía escrita.

Claude Design (APROBADO 11-nov-2026, versión 2): https://claude.ai/artifact/PNjJySuhgc1WJJUDYdEhAP

## Restricción de fondo
El repo es PÚBLICO: el material de cada negocio (PDF, videos, capturas con su
marca) NUNCA va a `public/` ni al repo. Vive en el almacenamiento de la
instancia (el mismo del catálogo: `local` por defecto, Azure Blob si
`CATALOG_STORAGE=azure-blob`), privado, servido por el CRM solo a usuarios con
sesión.

## Historias

### H1 — Propietario sube el material (P1)
Ajustes › **Material de capacitación** (pestaña nueva, solo Propietario):
- **Documentos para descargar**: PDF ≤ 25 MB. Nombre del botón editable,
  Reemplazar, Quitar, orden.
- **Videos**: MP4 ≤ 100 MB (Azure API 2021-08-06 admite un solo Put Blob de hasta 5000 MiB). Título, tema de la Ayuda (uno o «Ninguno: solo en
  la lista de videos»), subir/bajar de lugar, Quitar. Duración leída del propio
  archivo en el navegador al subir.
- **Imágenes de la Ayuda**: por tema, «Subir la tuya» / «Cambiar» / «Usar la de
  ejemplo» (PNG/JPEG/WebP ≤ 5 MB). La de ejemplo (`public/ayuda/*.png`) se
  queda en el repo y sigue siendo la que se ve si no hay propia.
- Tipo decidido por firma del archivo (reutilizar `src/server/media/file-policy.ts`),
  no por extensión.

### H2 — El equipo ve el material en la Ayuda (P1)
- La guía escrita de los 10 temas se queda COMPLETA, igual que hoy.
- Recuadro «Capacitación del equipo» arriba: botones de descarga de cada PDF
  (nombre · tamaño) + los videos en orden (título · duración). Un clic abre el
  video en un diálogo con «anterior / siguiente» y el enlace a su tema.
- En el índice, los temas con video llevan la etiqueta «Con video».
- En cada tema con video: selector «Imagen | Video · m:ss» junto a los pasos;
  el video se reproduce ahí mismo. Tema sin video: igual que hoy.
- Sin material subido: la Ayuda se ve exactamente como hoy (sin recuadro).

## Diseño técnico (propuesta)
- **Tabla** `training_asset` (prefijo `tra_`, `organization_id` NOT NULL,
  `scoped()`): `kind` (`document|video|help_image`), `title`, `topic_id`
  (id de `HELP_TOPICS`, nullable salvo `help_image`), `position`,
  `storage_provider`, `storage_key`, `mime_type`, `size_bytes`,
  `duration_seconds` (video), timestamps. Migración nueva `0029_…`
  re-ejecutable. Único parcial: un `help_image` por (org, topic).
- **Almacenamiento**: generalizar la clave a `{org}/{espacio}/{id}` con
  `espacio ∈ {catalog, capacitacion}` (sin romper las claves del catálogo) y
  ampliar el contrato con `stat(key)` (tamaño) y `getRange(key, start, end)`
  (local: lectura parcial del archivo; Azure: cabecera `Range`, que su firma
  ya contempla). Suite `runStorageContract` ampliada para ambos.
- **Rutas** (clasificar TODAS en `src/lib/permissions.ts`):
  - `GET /api/training` (any) — lista para la Ayuda.
  - `POST /api/training` (owner) — subida multipart.
  - `PATCH /api/training/[id]`, `DELETE /api/training/[id]` (owner).
  - `POST /api/training/reorder` (owner).
  - `GET /api/training/[id]/file` (any) — `Range`/206 para video,
    `Content-Disposition: attachment` para PDF, `Cache-Control: private`,
    cabeceras seguras de `src/server/media/serve.ts`.
- **Sin bandera**: no depende de terceros (Azure solo si ya está configurado
  para el catálogo) y es inerte sin material: la Ayuda no cambia hasta que el
  Propietario sube algo. Fuera de la purga de 30 días (tabla propia).

## Criterio de hecho
Gate técnico + E2E `scripts/e2e-ayuda-material.mjs` conectado al self-test:
subir PDF, video e imagen como Propietario → la Vendedora los ve en la Ayuda,
descarga el PDF, reproduce el video (respuesta 206 con `Range`), el tema
muestra «Imagen | Video»; quitar el material → la Ayuda vuelve a como estaba;
un archivo con extensión engañosa se rechaza. Probado con `CATALOG_STORAGE=local`
(y la suite de contrato con Azurite si está disponible). Luego subir el
material real de FUTURA en producción.

## Ajustes al diseño acordados con el dueño (11-nov-2026)
- El video va DEBAJO de los pasos, a todo el ancho (no en dos columnas): los
  subtítulos quemados se leen sin pantalla completa. Decisión del dueño.
- «¿Qué te está pasando?» solo aparece cuando hay material; sin el sufijo
  «los 10 temas» (el número cambia con la agenda).
- Ajustes sin breadcrumb (la columna de pestañas ya ubica); documentos
  muestran «PDF · tamaño» sin nombre original del archivo.
