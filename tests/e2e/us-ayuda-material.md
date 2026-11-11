# E2E — Ayuda con material de capacitación (034)

Guion de comportamiento observable. Spec:
[specs/034-ayuda-material/spec.md](../../specs/034-ayuda-material/spec.md).

Automatizado en `scripts/e2e-ayuda-material.mjs` (Playwright con Edge, que
decodifica H.264; dueño + vendedora) y, por API, en la sección 034 de
`scripts/e2e-selftest.mjs`:

```bash
# BD aislada, app viva con .env.e2e y CATALOG_STORAGE=local EXPLÍCITO en el
# server y en el guion (next dev también lee .env).
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-ayuda-material.mjs
# Capturas antes de quitar el material:
E2E_SHOTS=<carpeta> CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-ayuda-material.mjs
```

Fixtures genéricos (sin marca de ningún negocio) en
`tests/fixtures/capacitacion/`: un PDF de una página, un MP4 negro de 1 s
(H.264 yuv420p, `+faststart`) y un PNG de 64×40.

---

## a) Sin material, la Ayuda es la de siempre

1. Vendedora → `/ayuda`.
2. **Esperado**: sin recuadro «Capacitación del equipo», sin «Con video», sin
   pestañas «Imagen | Video»; las capturas de ejemplo de cada tema.

## b) El Propietario sube el material (H1)

1. Propietario → Ajustes › **Material de capacitación**.
2. **Esperado**: «Documentos para descargar», «Videos» e «Imágenes de la
   Ayuda»; «Todavía no hay documentos.» / «Todavía no hay videos.».
3. «Subir PDF» (dos veces), «Subir video» (dos veces) y, en «Ya no puedo
   escribirle al cliente», «Subir la tuya» con un PNG.
4. **Esperado**: cada video muestra su duración (0:01, leída por el
   navegador); la tarjeta del tema dice «Imagen de tu negocio» con «Cambiar» y
   «Usar la de ejemplo».
5. Cambia «Nombre del botón» del primer PDF a «Presentación de prueba» y
   Enter; mueve el segundo con ↑ y regrésalo con ↓; al primer video ponle el
   tema «Ya no puedo escribirle al cliente» y un título.

## c) La vendedora lo ve en la Ayuda (H2)

1. Vendedora → `/ayuda`.
2. **Esperado**: arriba «Capacitación del equipo» con «Presentación de prueba
   (PDF · 0.1 MB)» (botón principal) y el otro PDF; «1 · <título> 0:01» y «2 ·
   …». Clic en el PDF → se descarga «Presentación de prueba.pdf».
3. **Esperado**: en el índice, «Con video» solo en «Ya no puedo escribirle al
   cliente»; en ese tema, «Imagen | Video · 0:01» con Video activo y el video
   reproduciéndose ahí; «Imagen» muestra la imagen subida en lugar de la de
   ejemplo. Los temas sin video, igual que siempre.
4. Clic en «1 · …» → diálogo «Video 1 de 2 · 0:01», «En la guía: «Ya no puedo
   escribirle al cliente»», «2 · … ›». Siguiente → «Video 2 de 2» (sin «En la
   guía»: no tiene tema) y «‹ 1 · …». «En la guía» cierra y lleva al tema; Esc
   cierra y devuelve el foco.
5. A 390 px: sin scroll horizontal.

## d) Rangos (video en Safari/iOS)

- `Range: bytes=0-99` → 206, `Content-Range: bytes 0-99/<tamaño>`,
  `Accept-Ranges: bytes`, 100 bytes.
- Rango fuera de límites → 416 con `Content-Range: bytes */<tamaño>`.
- Sin `Range` → 200 completo con `Accept-Ranges`. Sin sesión → 401.

## e) La firma manda

- Un PNG renombrado a `.mp4` → 415 «El archivo no es un video MP4»; un MP4
  renombrado a `.pdf` → 415; un tema que no existe → 422. No queda nada.

## f) La vendedora no administra

- POST, PATCH, DELETE y reorder de `/api/training` → 403;
  `/settings/capacitacion` → 404.

## g) Fuera de la purga

- Purga de adjuntos forzada (+400 días): el material se sigue sirviendo.

## h) Quitar todo

1. Propietario: «Usar la de ejemplo» y «Quitar» en todo.
2. **Esperado**: la Ayuda vuelve a verse exactamente como en (a), y los
   archivos quitados responden 404.
