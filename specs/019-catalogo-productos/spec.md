# 019 — Catálogo de productos con categorías, variantes, fotos y fichas

**Carril**: ciclo completo (Principio VI). Toca modelo de datos (migración
0021), un conector opcional nuevo (Azure Blob, Principio II → ADR-003), una
página nueva, el compositor y el envío a los tres canales.

## Problema

Los clientes preguntan mucho por los modelos (vehículos): "¿tienes fotos del
T03?", "¿me pasas la ficha técnica del de 400 km?". Hoy el vendedor busca el
archivo en su equipo y lo adjunta **uno por uno** (el compositor de 018 manda
un archivo por envío), y cada envío vuelve a subir el archivo a Meta. Las
respuestas rápidas (tarea 09) solo insertan texto.

Objetivo: un **Catálogo** por organización (categorías → productos →
variantes) con detalles, **imágenes y documentos**, enviable desde la
conversación con un atajo (`/fotos_t03`, `/ficha_t03`) o con un botón
**Catálogo** en el compositor, reutilizando lo ya subido a Meta. Simple: no es
un e-commerce.

## Decisiones del dueño (15-oct-2026)

1. **Almacenamiento del catálogo**: disco local por defecto; **Azure Blob**
   como conector opcional, configurado **solo con variables de despliegue**
   (Coolify). Ajustes muestra el estado y "Probar conexión", nunca la cadena.
2. **Azure solo para el catálogo.** Los adjuntos del chat siguen en la caché
   local de 30 días de 018.
3. **Atajos ligados al producto** (no a una variante): `/ficha_t03` manda los
   documentos compartidos y los de todas sus variantes. La variante exacta se
   elige con el botón Catálogo.
4. Entran en esta versión: **categorías**, **variantes**, **botón Catálogo**
   y **reutilización** de lo ya subido a Meta.
5. (Del plan v1, sin cambios) página `Catálogo` de primer nivel para todos los
   roles con edición solo del Propietario; el agente IA **no** envía archivos
   del catálogo; se respeta la ventana de 24 h.

Defaults tomados (con el asesor): Instagram recibe la **URL firmada del CRM**
(no se expone Azure a Meta); el hilo guarda una **copia** de lo enviado en la
caché de 30 días (el historial muestra lo que se mandó aunque el catálogo
cambie después); cambiar de proveedor **no** migra lo ya subido (cada archivo
recuerda dónde se guardó).

## Escenarios

1. El Propietario crea la categoría "SUV" y el producto "Tiguan" (código
   `T03`, precio "desde $589,900", atributos *Motor: eléctrico*). Le agrega
   las variantes "400 km" (`T03-400`, $629,900, *Autonomía: 400 km*) y
   "300 km" (`T03-300`). Sube 4 fotos compartidas y una ficha PDF por
   variante. Con "Crear atajos" genera `/fotos_t03` y `/ficha_t03`.
2. Un Vendedor escribe `/FOT` + Enter en una conversación de WhatsApp: el
   campo queda con "Te comparto las fotos de Tiguan" y debajo 4 miniaturas
   como chips removibles. Nada sale solo. Pulsa enviar: sale el texto y luego
   las 4 fotos, en orden.
3. El cliente pide la ficha del de 400 km. El Vendedor pulsa **Catálogo**,
   filtra "SUV", elige Tiguan → 400 km, marca la ficha y "Insertar detalles"
   (nombre, variante, precio, atributos como texto editable) y envía.
4. Al día siguiente otro vendedor manda las mismas fotos por el mismo número:
   **no se re-suben** a Meta (se reutiliza el id); llegan igual.
5. En Instagram, `/ficha_t03` con un `.xlsx` y un PDF: el `.xlsx` aparece en
   gris ("Instagram solo acepta imágenes y PDF") y no se envía.
6. El Vendedor abre Catálogo: ve categorías, productos, variantes, fotos y
   descarga fichas; no ve botones de edición; `POST /api/catalog/...` → 403.
7. Con `CATALOG_STORAGE=azure-blob`, los archivos nuevos van al contenedor; si
   Azure no responde, subir falla con un mensaje claro, el catálogo se sigue
   viendo (miniaturas rotas) y un envío manda el texto y marca ese archivo
   como fallido.

## Requisitos

### Catálogo (datos y gestión)
- **FR-901** `product_category`: `name` (1–60), `position`. Un nivel.
- **FR-902** `product`: `category_id` (opcional, `ON DELETE SET NULL`),
  `name` (1–120), `code` (opcional), `price` (texto ≤ 60), `description`
  (≤ 4000), `attributes` (lista `{label ≤ 40, value ≤ 200}`, ≤ 30), `active`,
  `position`.
- **FR-903** `product_variant`: `product_id` (CASCADE), `name` (1–80),
  `code` (opcional), `price` (opcional: si falta se muestra el del producto),
  `attributes` (se muestran después de los del producto), `active`,
  `position`.
- **FR-904** Códigos `^[A-Za-z0-9_-]{1,32}$`, **únicos por org entre
  productos y variantes** sin distinguir mayúsculas (409
  `duplicate_code`).
- **FR-905** `product_file`: `product_id`, `variant_id` (nulo = compartido
  por todas las variantes), `kind` `image` (JPEG/PNG) | `document` (PDF,
  docx, xlsx, pptx, txt, csv) decidido **por la firma** (`inspectOutgoing`
  de 018); otro → 415 con razón. ≤ 20 por producto. Tope `MAX_FILE_BYTES`
  con precorte 413. Si falla la validación o el storage, no queda nada en BD
  ni en el storage.
- **FR-906** CRUD de categorías, productos, variantes y archivos solo
  Propietario (403); lectura para cualquier rol. Todo por `scoped()`.
- **FR-907** Inactivo (producto o variante): atenuado en Catálogo, fuera del
  selector del compositor y de los atajos.
- **FR-908** Borrar un archivo/variante/producto borra sus bytes del storage
  (best-effort: el fallo se registra, no revierte) y sus ids reutilizables.
  Borrar una categoría deja sus productos sin categoría.

### Almacenamiento (conector, ADR-003)
- **FR-910** Contrato `CatalogStorage { put, get, delete, test }`.
  Implementaciones: `local` (default, `MEDIA_DIR/{org}/catalog/{fileId}`) y
  `azure-blob` (REST con SharedKey, sin SDK). Clave siempre con prefijo de
  org.
- **FR-911** Selección por despliegue: `CATALOG_STORAGE=local|azure-blob`
  (default `local`), `AZURE_STORAGE_CONNECTION_STRING` (forma con
  `AccountKey`; también la de Azurite), `AZURE_STORAGE_CONTAINER`. Con
  `azure-blob` y config inválida, el arranque registra el error y el
  catálogo responde 503 en subidas/lecturas a Azure; el resto del CRM sigue.
- **FR-912** Cada `product_file` guarda `storage_provider` + `storage_key`;
  se lee y borra en el proveedor donde se guardó.
- **FR-913** Con el conector apagado, la UI no menciona Azure. Encendido,
  Ajustes muestra "Almacenamiento del catálogo: Azure Blob · cuenta ·
  contenedor" y "Probar conexión". La `AccountKey` jamás sale al cliente ni a
  logs (errores de Azure saneados).
- **FR-914** `GET /api/catalog/files/:id` (cualquier miembro) sirve por
  proxy con las cabeceras seguras de 018; el contenedor es privado.
- **FR-915** La purga de 30 días no toca el catálogo.

### Respuestas rápidas ligadas a producto
- **FR-920** `quick_reply` gana `product_id` (`ON DELETE SET NULL`) y
  `attach` (`images | documents | all`), ambos o ninguno. Archivos del atajo
  = compartidos + de variantes **activas**, filtrados por `attach`.
- **FR-921** `body` opcional solo con producto; nueva variable
  `{{producto}}` (sin producto → 422).
- **FR-922** `GET /api/quick-replies` incluye `product: { id, name, code,
  active, files: [...] }` ya filtrado.
- **FR-923** Búsqueda del selector sin distinguir mayúsculas.
- **FR-924** "Crear atajos" (producto con código): `fotos_<code>` y
  `ficha_<code>` en minúsculas; los existentes se informan y no se tocan.

### Compositor
- **FR-930** Elegir una respuesta ligada inserta el texto (editable) y
  escenifica sus archivos como chips removibles. Nada se envía solo.
- **FR-931** Botón **Catálogo** (solo con `replyMode` `free`/`human_agent`):
  panel con búsqueda y filtro por categoría → producto → variante (opcional)
  → casillas de archivos (compartidos + de la variante) → "Agregar" los
  escenifica; "Insertar detalles" pone en el campo el texto
  `nombre · variante · precio` + atributos.
- **FR-932** Chips incompatibles con `conversation.outboundFiles` en gris con
  razón; no se envían.
- **FR-933** Enviar con chips → `POST /api/conversations/:id/messages/catalog`
  `{ text?, fileIds (1–10) }`; resumen al terminar ("3 de 4 enviados…");
  botón deshabilitado mientras viaja.

### Envío y reutilización
- **FR-940** El endpoint: visibilidad (404) → **un** `gateSend` → `sendText`
  si hay texto → por archivo, en orden: leer del storage → copia en la caché
  de 30 días (`media_asset`, con `product_file_id` como procedencia) → envío
  al canal.
- **FR-941** Resultado por archivo `sent | skipped | failed`. 413/415 del
  canal → `skipped`; `not_found`, `file_missing`, `storage_unavailable`,
  `meta_error`, `upload_failed` → `failed` y sigue; `window_closed`,
  `not_connected`, `reconnect_required`, `sandbox_violation`,
  `meta_unavailable`, `unsupported_channel` → detiene el lote. Ningún
  `fileId` válido → 404 sin enviar.
- **FR-942** **Reutilización WhatsApp**: `product_file_upload`
  `(product_file_id, channel, account_id)` UNIQUE guarda el media id; se
  reutiliza si tiene < 25 días. Si Meta rechaza el id cacheado con un 4xx que
  no sea de autenticación → se invalida y se re-sube **una** vez; auth →
  `reconnect_required`; 5xx → `meta_unavailable`.
- **FR-943** **Reutilización Messenger**: subida con la Attachment Upload API
  (`is_reusable: true`) → `attachment_id` reutilizable (Meta lo guarda 90 días; se reutiliza < 85), misma regla de
  re-subida. **Instagram**: URL firmada del CRM de la copia; nada que cachear.
- **FR-944** La caché de ids se consulta y escribe **después** del guard de
  sandbox: una conversación `is_test` no toca Meta **ni** `product_file_upload`.
- **FR-945** Reemplazar o borrar un archivo invalida sus ids reutilizables.

## Permisos por rol

| Acción | Propietario | Vendedor |
|---|---|---|
| Ver Catálogo (categorías, productos, variantes, fotos, fichas) | ✅ | ✅ |
| Crear/editar/borrar categorías, productos, variantes, archivos | ✅ | ❌ (403, sin botones) |
| Ligar una respuesta rápida a un producto; ver estado del almacenamiento | ✅ | ❌ (Ajustes) |
| Usar atajos y botón Catálogo para enviar | ✅ | ✅ (conversaciones que ve) |

## Criterios de aceptación

1. **Atajo**: producto con 2 fotos y un PDF, `/fotos_t03`; el Vendedor escribe
   `/FOT` + Enter y envía → el outbox recibe texto + 2 `image`; el hilo
   muestra 3 salientes, las fotos con `media_asset_id`.
2. **Quitar chip** → sale una foto menos.
3. **Botón Catálogo**: elegir variante "400 km" + su ficha + "Insertar
   detalles" → sale el texto con "400 km" y el precio de la variante, y el PDF
   de esa variante (no el de 300 km).
4. **Reutilización**: el mismo lote enviado dos veces por WhatsApp → la
   segunda vez **cero** subidas nuevas a `/media`; con el id cacheado marcado
   inválido en el mock → exactamente una re-subida y el envío llega.
5. **Instagram**: `.xlsx` → `skipped` sin tocar Meta; el PDF sale.
6. **Permisos**: Vendedor 403 en toda escritura, 200 en lectura.
7. **Archivo disfrazado**: `.exe` renombrado a `.pdf` → 415; nada en BD ni
   storage.
8. **Purga**: tras `POST /api/dev/media/purge`, el catálogo sigue sirviendo
   200 y las copias del hilo quedan como expiradas.
9. **Ventana cerrada** → `window_closed`, nada sale. **`is_test`** →
   `sandbox_violation`, outbox vacío y `product_file_upload` vacío.
10. **Borrar producto** → sus archivos 404 y fuera del storage; el atajo
    queda sin producto; el hilo conserva su copia.
11. **Azure (Azurite)**: con `CATALOG_STORAGE=azure-blob` se sube, se sirve,
    se envía y se borra en el contenedor; con Azurite apagado → subida 503 con
    mensaje claro, el lote manda el texto y marca el archivo `failed`.
12. **Apagado**: con la config por defecto, la UI no contiene "Azure" y todo
    1–10 pasa en `local`.

## Casos borde y degradación

- Archivo escenificado borrado antes de enviar → `failed: not_found`; el
  resto sale.
- Fila en BD sin bytes en el storage → `failed: file_missing`, se registra.
- Dos vendedores envían el mismo archivo a la vez sin id cacheado → dos
  subidas, gana la última (upsert); inofensivo.
- Reconectar otro número de WhatsApp → los ids del anterior no se usan (la
  clave incluye la cuenta).
- `GET /api/quick-replies` o `GET /api/catalog` fallan → el compositor
  funciona sin atajos ni botón (como 09).

## Fuera de alcance (v1)

- Azure para adjuntos del chat; migrar archivos entre proveedores; URLs SAS.
- Atajos ligados a una variante concreta.
- Que el agente IA consulte o envíe el catálogo.
- Video, inventario/stock, categorías anidadas, importación masiva,
  miniaturas generadas en el servidor.

## Ampliación (15-oct): imágenes convertidas en el navegador

Decisión del dueño (15-oct-2026): WhatsApp e Instagram solo envían imágenes
JPG/PNG (en WhatsApp el WebP es solo sticker), y las fotos de teléfono suelen
venir en HEIC o pesar más de 5 MB. El **navegador** convierte y reduce antes
de subir. El servidor **no** cambia su lista blanca (JPG/PNG por firma,
`file-policy.ts`) y **no** se añaden dependencias nativas (nada de `sharp`).

- **FR-950** Módulo de cliente `src/lib/image-normalize.ts` (sin imports de
  servidor). `planImageNormalization` (pura): JPG/PNG ≤ tope → se queda;
  JPG/PNG > tope → re-codificar (`size`); WebP/GIF/HEIC/HEIF/BMP/AVIF (por
  MIME o, si el MIME viene vacío u `octet-stream`, por extensión) → JPEG
  (`format`) con el nombre en `.jpg`; cualquier otra cosa (PDF, Office,
  audio…) → se queda.
- **FR-951** `normalizeImageFile` decodifica (`createImageBitmap` con
  orientación EXIF; si falla, `<img>`), pinta sobre fondo **blanco** y
  codifica `image/jpeg`: lado mayor ≤ 2560 px a calidad 0.85 → 0.75 → 0.65
  y luego escala ×0.8 hasta quedar ≤ 98 % del tope (máx. 10 intentos). Un
  GIF conserva solo el primer fotograma (aviso). Si el navegador no puede
  decodificarlo (p. ej. HEIC en Chrome/Edge) o no logra bajarlo del tope,
  devuelve el **original** con un aviso legible ("Tu navegador no puede
  convertir este formato; súbela como JPG o PNG") y el servidor responde su
  415/413 como siempre. Nunca lanza.
- **FR-952** Catálogo: cada imagen se normaliza antes de su POST con tope
  **5 MB** (el de WhatsApp, el más bajo de los tres canales), para que toda
  foto del catálogo sirva en WhatsApp, Messenger e Instagram. El `accept`
  del input suma `.webp,.gif,.heic,.heif` (y sus MIME); la fila de la subida
  dice "convertida a JPG (…)" / "reducida a … MB" y el aviso si lo hay.
- **FR-953** Clip del compositor (adjunto suelto de 018): si el canal tiene
  regla `image` en `outboundFiles`, el `accept` suma WebP/GIF/HEIC/HEIF y la
  imagen elegida se normaliza con el tope de imagen **de ese canal** antes de
  la vista previa (Enviar deshabilitado mientras se prepara); un aviso breve
  dice si se convirtió/redujo. Sin regla `image`, el clip no cambia.

### Criterios de aceptación (E2E, `e2e-catalogo` f2 y `e2e-adjuntos-ui`)

- AC-13 Propietario sube `foto.webp` (generada en el navegador) → el
  catálogo guarda `kind=image`, `image/jpeg`, `foto.jpg`; un PNG de ruido de
  3000×3000 (> 5 MB) queda JPEG ≤ 5 MB con lado mayor ≤ 2560 px; ambos salen
  por WhatsApp en un lote con `status: sent`.
- AC-14 Clip en una conversación de WhatsApp: `foto.webp` → aviso
  "convertida a JPG"; el wa-mock recibe `type=image` subida a `/media` como
  `image/jpeg` y el hilo muestra la imagen.
- AC-15 Un `.heic` ilegible → la UI muestra el aviso del navegador, el
  servidor responde 415 y la UI no se cuelga (fila en error en el catálogo;
  error visible y Enviar disponible en el compositor).
