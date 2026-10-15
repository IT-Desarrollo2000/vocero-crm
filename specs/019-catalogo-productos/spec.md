# 019 — Catálogo de productos con fotos y fichas, enviables por respuesta rápida

**Carril**: ciclo completo (Principio VI). Toca modelo de datos (migración
0021: tablas nuevas + columnas aditivas en `quick_reply`), una página nueva y
un endpoint de envío.

## Problema

Los clientes preguntan mucho por los modelos (vehículos): "¿tienes fotos del
T03?", "¿me pasas la ficha técnica?". Hoy el vendedor busca el archivo en su
computadora o celular y lo adjunta **uno por uno** (el compositor de 018 manda
un archivo por envío). Las respuestas rápidas (tarea 09) solo insertan texto:
"adjuntos en respuestas rápidas" quedó explícitamente fuera de alcance.

Objetivo: un **Catálogo** por organización con productos, sus detalles y sus
**imágenes y documentos**, y poder ligar una respuesta rápida a un producto
para que `/FOTOS_T03` o `/FICHA_T03` deje listos en el compositor el texto y
los archivos, y se envíen con un clic. Simple: no es un e-commerce.

## Decisiones (15-oct-2026)

1. **Sin bandera.** No hay tercero y es una extensión de las respuestas
   rápidas, que son núcleo. Un catálogo vacío no cambia nada para quien no lo
   usa (igual que una lista vacía de respuestas rápidas). La regla de módulos
   opcionales (015/016) aplica a superficies que dependen de un tercero o de
   configuración externa; aquí no hay ninguna.
2. **Página de primer nivel `Catálogo`** visible para **todos los roles**: el
   Vendedor la hojea (fotos, fichas, precio) en modo lectura; solo el
   Propietario crea, edita, sube y borra. Igual que las respuestas rápidas: el
   catálogo es la voz oficial del negocio.
3. **El atajo apunta a un producto + un tipo de archivo** (`images`,
   `documents`, `all`), no a archivos sueltos: una foto nueva del T03 entra
   sola en `/fotos_t03` sin editar el atajo.
4. Los archivos del catálogo viven **fuera de la caché de 30 días** (tabla y
   carpeta propias). Cada envío **copia** el archivo al flujo de adjuntos de
   018: la copia del hilo sí caduca a los 30 días como cualquier saliente.
5. Se envía **igual que hoy**: dentro de la ventana de 24 h (o la etiqueta de
   agente humano en IG/Messenger). Fuera de ventana no hay respuestas rápidas.
6. El agente IA **no** envía archivos del catálogo (se mantiene la decisión 4
   de 018).

## Escenarios

1. El Propietario crea "Tiguan T03" (código `T03`, precio "$589,900",
   descripción), sube 4 fotos y la ficha técnica PDF. Con un botón crea los
   atajos `/fotos_t03` (imágenes) y `/ficha_t03` (documentos).
2. Un Vendedor, en una conversación de WhatsApp, escribe `/FOT`, elige
   "Fotos T03" con Enter: el campo queda con "Hola María, te comparto las
   fotos del Tiguan T03" y debajo aparecen 4 miniaturas como chips
   removibles. Nada se envía solo. Pulsa enviar: sale el texto y luego las 4
   fotos, en orden.
3. El Vendedor quita una foto del lote antes de enviar; solo salen 3.
4. En Instagram el mismo atajo `/ficha_t03` con un `.xlsx` y un PDF: el chip
   del `.xlsx` aparece en gris ("Instagram solo acepta imágenes y PDF") y no se
   envía; el PDF sí.
5. Un Vendedor abre Catálogo: ve productos, fotos y descarga la ficha; no ve
   botones de edición, y `POST /api/catalog` le responde 403.
6. Pasan 30 días: la purga de adjuntos corre y los archivos del catálogo
   siguen ahí (las copias enviadas en el hilo sí muestran "Archivo eliminado").
7. El Propietario borra el producto: sus archivos se borran del disco; los
   atajos ligados quedan sin producto (si no tenían texto, el selector los
   oculta y Ajustes los marca "Sin producto").

## Requisitos

### Catálogo
- **FR-901** `product` por organización: `name` (1–120), `code` (opcional,
  1–32, `^[A-Za-z0-9_-]+$`, único por org sin distinguir mayúsculas), `price`
  (texto libre opcional, ≤ 60), `description` (opcional, ≤ 4000), `active`
  (bool, default true), `position`.
- **FR-902** `product_file`: hasta **20** por producto, `kind` `image`
  (JPEG/PNG) o `document` (PDF, docx, xlsx, pptx, txt, csv). El tipo se decide
  **por la firma** con `inspectOutgoing` de 018 (nunca por la extensión);
  cualquier otra cosa → 415 con la razón legible. Tope de tamaño:
  `MAX_FILE_BYTES` de 018 (precorte por `content-length`, 413).
- **FR-903** Archivos en `MEDIA_DIR/{org}/catalog/{fileId}`. La purga de 018
  no los toca (no tienen fila en `media_asset`). Borrar un archivo o su
  producto borra el archivo del disco; un fallo al borrar del disco se registra
  y no revierte la operación.
- **FR-904** `GET /api/catalog/files/:id` sirve el archivo a cualquier miembro
  de la org con las cabeceras seguras de 018 (`nosniff`, CSP, content-type
  detectado; imágenes inline, documentos como descarga).
- **FR-905** CRUD de productos y archivos solo Propietario (403 al Vendedor);
  lectura (`GET /api/catalog`) para cualquier rol. Todas las queries por
  `scoped()`.
- **FR-906** Producto inactivo: se ve atenuado en Catálogo y sus atajos no
  aparecen en el selector del compositor.

### Respuestas rápidas ligadas a producto
- **FR-910** `quick_reply` gana `product_id` (FK `ON DELETE SET NULL`) y
  `attach` (`images | documents | all | null`). Ambos o ninguno.
- **FR-911** `body` pasa a ser opcional **solo** si la respuesta tiene
  producto + `attach`; sin producto sigue siendo obligatorio (422 como hoy).
  Las variables de 09 siguen válidas y se suma `{{producto}}` (nombre del
  producto ligado; en una respuesta sin producto es variable desconocida →
  422).
- **FR-912** `GET /api/quick-replies` devuelve, por respuesta ligada,
  `product: { id, name, code, active, files: [{ id, kind, mimeType, fileName, size }] }`
  con los archivos ya filtrados por `attach` y en orden de `position`.
- **FR-913** La búsqueda del selector no distingue mayúsculas: `/FOTOS_T03`
  encuentra `fotos_t03`.
- **FR-914** Botón "Crear atajos" en el producto (requiere `code`): crea
  `fotos_<code>` (imágenes, "Te comparto las fotos de {{producto}}") y
  `ficha_<code>` (documentos, "Te comparto la ficha técnica de
  {{producto}}") en minúsculas; si un atajo ya existe se informa y se deja
  intacto.

### Compositor y envío
- **FR-920** Elegir una respuesta ligada inserta su texto (editable, como
  RF-09-24) y **escenifica** sus archivos como chips con miniatura (imagen) o
  nombre (documento), cada uno removible. Nada se envía solo.
- **FR-921** Los archivos incompatibles con el canal según
  `conversation.outboundFiles` (tipo o tamaño) se muestran en gris con la
  razón y no se envían.
- **FR-922** Enviar con archivos escenificados llama a
  `POST /api/conversations/:id/messages/catalog` con `{ text?, fileIds }`
  (1–10 archivos). El servidor: visibilidad (404) → **un solo** `gateSend`
  (responder = tomar, RF-09-07) → `sendText` si hay texto → `sendMediaMessage`
  por archivo, **secuencial y en orden**, leyendo el archivo del catálogo.
- **FR-923** Resultado por archivo: `sent` (con `messageId`), `skipped`
  (incompatible: 413/415 de la política del canal) o `failed`. Un archivo
  saltado no aborta el lote. Un error que afecta a la conversación
  (`window_closed`, `not_connected`, `reconnect_required`,
  `sandbox_violation`, `meta_unavailable`) detiene el lote y se reporta; lo ya
  enviado queda enviado.
- **FR-924** El compositor muestra el resumen ("3 de 4 enviados; 1 no es
  compatible con Instagram") y limpia los chips enviados.
- **FR-925** Un `fileId` de otra org o inexistente → 404 sin enviar nada.
- **FR-926** Sandbox: una conversación `is_test` sigue lanzando
  `sandbox_violation` (guardrail intocable).

## Permisos por rol

| Acción | Propietario | Vendedor |
|---|---|---|
| Ver Catálogo, fotos y descargar fichas | ✅ | ✅ |
| Crear/editar/borrar productos, subir/borrar archivos | ✅ | ❌ (403, sin botones) |
| Ligar una respuesta rápida a un producto | ✅ | ❌ (Ajustes es del Propietario) |
| Usar `/atajo` con archivos y enviarlos | ✅ | ✅ (en conversaciones que ve) |

## Criterios de aceptación

1. **Dado** un producto con 2 fotos y un PDF y el atajo `/fotos_t03`
   (imágenes), **cuando** el Vendedor escribe `/FOT` + Enter en una
   conversación de WhatsApp abierta y pulsa enviar, **entonces** el outbox de
   Meta recibe el texto y luego 2 `image` (subidos como media), y el hilo
   muestra 3 mensajes salientes, las fotos con `media_asset_id`.
2. **Dado** el mismo lote, **cuando** el Vendedor quita un chip, **entonces**
   sale una foto menos.
3. **Dado** una conversación de Instagram y `/ficha_t03` con un `.xlsx` y un
   PDF, **cuando** se envía, **entonces** el PDF sale y el `.xlsx` vuelve como
   `skipped` sin llegar a Meta.
4. **Dado** un Vendedor, **cuando** hace `POST /api/catalog` o sube un archivo,
   **entonces** 403; **cuando** pide `GET /api/catalog`, **entonces** 200.
5. **Dado** un archivo `.exe` renombrado a `.pdf`, **cuando** el Propietario lo
   sube, **entonces** 415 y nada queda en disco ni en BD.
6. **Dado** un producto con archivos, **cuando** corre la purga de 30 días
   (`POST /api/dev/media/purge`), **entonces** `GET /api/catalog/files/:id`
   sigue respondiendo 200.
7. **Dado** una conversación con la ventana cerrada, **cuando** se intenta
   `POST .../messages/catalog`, **entonces** `window_closed` y nada sale.
8. **Dado** una conversación `is_test`, **cuando** se envía un lote,
   **entonces** `sandbox_violation` y nada sale.
9. **Dado** que el Propietario borra el producto, **entonces** sus archivos
   desaparecen del disco y el atajo queda con `product_id = NULL`.

## Casos borde y degradación

- Producto o archivo borrado con el lote ya escenificado → ese archivo vuelve
  como `failed: not_found` (404 si ninguno existe); el resto sale.
- Archivo del catálogo con fila en BD pero ausente en disco → `failed:
  file_missing`, se registra, el lote sigue.
- Fallo de Meta en un archivo (`meta_error`, `upload_failed`) → ese archivo
  queda `failed` (el mensaje en el hilo queda como fallido, como en 018) y el
  lote sigue; `meta_unavailable` detiene el lote.
- El `GET /api/quick-replies` falla → el compositor funciona sin atajos (como
  09).
- Doble clic en enviar → el botón se deshabilita mientras el lote viaja.

## Fuera de alcance (v1)

- Caché del `wa_media_id` para no re-subir (cada envío re-sube; aceptable).
- Que el agente IA consulte o envíe el catálogo.
- Selector de productos en el compositor fuera de los atajos.
- Video en el catálogo, variantes/inventario/precios estructurados,
  categorías, búsqueda avanzada, importación masiva.
