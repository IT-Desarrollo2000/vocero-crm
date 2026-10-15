# E2E — 019 Catálogo de productos

Automatizado en `scripts/e2e-catalogo.mjs` (BD aislada + mocks):

```bash
node --env-file=.env.e2e scripts/e2e-catalogo.mjs
# en Windows sin Chromium de Playwright: E2E_BROWSER_CHANNEL=msedge
```

Spec: [specs/019-catalogo-productos/spec.md](../../specs/019-catalogo-productos/spec.md).

## Preparación

- Propietario con WhatsApp conectado (wa-mock) y una Vendedora.
- Categoría "SUV", producto "Tiguan" (código `T03`, precio "desde $589,900",
  atributo *Motor: eléctrico*), variantes "400 km" (`T03-400`, $629,900) y
  "300 km" (`T03-300`, sin precio → hereda).
- Archivos: 2 fotos PNG compartidas, una ficha PDF por variante y un
  `resumen.txt` compartido.

## Pasos y resultado esperado

| # | Paso | Esperado |
|---|---|---|
| 1 | Subir un `.exe` renombrado a `.pdf` | 415 con razón legible; nada en BD ni en disco |
| 2 | Variante con el código del producto en minúsculas | 409 `duplicate_code` |
| 3 | Vendedora: abrir `/catalog` | Ve categorías, productos, variantes y archivos; sin botones de edición; toda escritura por API → 403 |
| 4 | "Crear atajos" en Tiguan | Se crean `/fotos_t03` (imágenes) y `/ficha_t03` (documentos); repetir → "Ya existía" |
| 5 | En una conversación de WhatsApp abierta, la Vendedora escribe `/FOTOS_T03` + Enter | Texto "Te comparto las fotos de Tiguan" y 2 chips; nada sale |
| 6 | Quitar una foto y enviar | Sale el texto + 1 foto; chips limpios; resumen "enviados" |
| 7 | Botón **Catálogo** → Tiguan → 400 km → marcar su ficha → Insertar detalles → Agregar → enviar | El panel no ofrece la ficha de 300 km; sale el texto con "400 km" y "$629,900" + el PDF |
| 8 | Instagram: lote con `resumen.txt` + ficha PDF | `.txt` → `skipped` ("Instagram solo acepta imágenes (JPG/PNG) y PDF"); el PDF sale |
| 9 | Lote a una conversación con la ventana cerrada | 409 `window_closed`; nada sale |
| 10 | Lote a una conversación `is_test` | Rechazado (sandbox); nada sale |
| 11 | Lote con un id inexistente y texto | 404; el texto tampoco sale |
| 12 | Purga forzada `POST /api/dev/media/purge {advanceDays:31}` | El catálogo sigue sirviendo 200; las copias del hilo quedan expiradas |
| 13 | Borrar el producto | Sus archivos 404 y fuera del disco; los atajos quedan "Sin producto"; el hilo conserva sus mensajes |
