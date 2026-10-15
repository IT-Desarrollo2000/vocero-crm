# 018 — Adjuntos seguros en WhatsApp, Messenger e Instagram (caché de 30 días)

**Carril**: ciclo completo. Toca modelo de datos (migración 0020), superficie
pública (una ruta firmada sin sesión) y los tres canales.

## Problema

Los vendedores necesitan mandar **cotizaciones (PDF, imágenes, ofimática)** y
ver las **fotos y archivos que mandan los clientes** (p. ej. el vehículo por el
que preguntan) en WhatsApp, Messenger e Instagram. Hoy:

- WhatsApp sí recibe y envía, pero **sin control de tipo**: cualquier archivo
  sale como documento (un `.exe` pasa) y el tipo lo declara el navegador.
- `GET /api/media/[assetId]` sirve **inline con el content-type del
  remitente**, sin `nosniff` ni CSP: un HTML o SVG enviado por un cliente se
  ejecuta en el origen del CRM al abrirlo (XSS almacenado).
- Instagram y Messenger **descartan** los adjuntos entrantes (un DM con solo
  una foto no deja rastro) y no pueden enviar ninguno.
- Los archivos se guardan en disco **para siempre**: el volumen crece sin
  límite.

## Hechos de Meta que fijan el diseño (docs oficiales, oct-2026)

- WhatsApp: los media id **entrantes caducan a los 7 días**; los subidos por
  el negocio, a los 30. URL de descarga: 5 min, con Bearer.
- Messenger: envío multipart con `filedata` en `POST /{page}/messages`
  (25 MB). Entrantes: `message.attachments[].payload.url` (CDN, TTL no
  documentado).
- Instagram (IG Login, graph.instagram.com): envío **solo por URL pública**
  (`payload.url`) — no hay subida documentada. Imagen png/jpeg 8 MB; archivo
  **solo PDF** 25 MB. Entrantes como Messenger.

## Decisiones del dueño (14-oct-2026)

1. Adjuntos en Messenger e Instagram: **necesarios ya**.
2. Lista blanca de uso de oficina, sin macros.
3. Nada se conserva más de 30 días → **opción B**: el disco es una **caché
   temporal**; todo archivo se borra solo a los 30 días y la UI lo avisa.
4. El agente IA **no envía archivos**.

## Escenarios

1. Un vendedor adjunta una cotización PDF en WhatsApp, Messenger o Instagram;
   llega al cliente y se ve en el hilo como tarjeta descargable.
2. Un cliente manda la foto de un vehículo por cualquiera de los tres canales;
   se ve dentro del chat.
3. Un vendedor intenta mandar un `.exe`, un `.zip`, un `.docm` o un `.docx`
   con macros: se rechaza con un mensaje claro, antes de tocar a Meta.
4. Un cliente manda un HTML/SVG/ejecutable: el hilo lo muestra como "Archivo
   bloqueado por seguridad" y no hay forma de abrirlo desde el CRM.
5. Un `.docx` por Instagram: el compositor explica "Instagram solo acepta
   imágenes y PDF".
6. Un cliente comparte una historia o un reel por Instagram: aparece
   "[adjunto no soportado]" en vez de un mensaje vacío.
7. A los 30 días el archivo desaparece del disco; el hilo muestra "Archivo
   eliminado (los archivos se guardan 30 días)" y el agente sigue viendo su
   marcador.

## Requisitos

### Política de archivos (todos los canales)

- **FR-801** Un único módulo (`src/server/media/file-policy.ts`) decide el
  tipo **por la firma del contenido (magic bytes)**, nunca por la extensión ni
  el MIME declarado. Lista blanca:
  - Imágenes: JPEG, PNG (envío y recepción); WEBP y GIF (solo recepción).
  - PDF.
  - Ofimática OOXML: `.docx`, `.xlsx`, `.pptx` — ZIP con
    `[Content_Types].xml`; se rechaza si contiene `vbaProject.bin` o es una
    variante habilitada para macros.
  - Texto: `.txt`, `.csv` — UTF-8 válido, sin NUL, sin cabecera HTML/SVG/XML.
  - Audio (ogg/opus, mp3, aac, amr, m4a, wav) y video (mp4, 3gpp, mov, webm)
    — necesarios para notas de voz de WhatsApp.
- **FR-802** Se bloquea todo lo demás, con razón legible: ejecutables (MZ,
  ELF, scripts `#!`), comprimidos (zip no-Office, rar, 7z, gz), Office
  binario antiguo (`.doc/.xls/.ppt`: "guárdalo como .docx/.xlsx/.pptx"),
  HTML, SVG, XML. PDF con `/JavaScript` o `/Launch` visibles → bloqueado
  (detección de mejor esfuerzo).
- **FR-803** Orden de validación en el envío: tope global de tamaño → firma y
  lista blanca (415) → matriz del canal: tipo (415 con mensaje por canal) y
  tamaño (413).

### Matriz por canal (`capabilities.ts`)

- **FR-804** `outboundFiles` por canal (sustituye el booleano
  `outboundMedia`) + `outboundStructured` (ubicación/contactos):

  | Canal | Imagen | Documento | Audio/Video | Ubicación/contacto |
  |---|---|---|---|---|
  | WhatsApp | jpeg/png 5 MB | pdf, docx, xlsx, pptx, txt, csv 100 MB (csv sale como `text/plain`) | sí (16 MB) | sí |
  | Messenger | jpeg/png 25 MB | pdf, docx, xlsx, pptx, txt, csv 25 MB | sí (25 MB) | no |
  | Instagram (Meta) | jpeg/png 8 MB | **solo pdf** 25 MB | no | no |
  | Instagram (Zernio) | no | no | no | no |

- **FR-805** El compositor muestra el clip según `outboundFiles`, pone
  `accept` con las extensiones permitidas del canal y muestra los rechazos
  del servidor tal cual. *Ampliación 15-oct:* si el canal envía imágenes, el
  clip acepta además WebP/GIF/HEIC/HEIF y el navegador convierte/reduce la
  imagen a JPG con el tope del canal antes de enviarla — ver
  [019 § Ampliación (15-oct)](../019-catalogo-productos/spec.md) (FR-953).
  El servidor no cambia: AC-3 (PNG de 6 MB → 413) sigue valiendo por API.

### Entrantes

- **FR-806** WhatsApp: tras descargar, se verifica la firma; el MIME guardado
  es el detectado. Si está bloqueado, el binario **no** se guarda:
  `fetch_status = "blocked"` + razón.
- **FR-807** Messenger e Instagram (Meta): se parsea
  `message.attachments[]`. `image|video|audio|file` → un mensaje por adjunto
  (`ig_<mid>` / `fb_<mid>` para el primero, `…#<i>` para el resto; el texto,
  si lo hay, es el caption del primero) con `source_url` y descarga inmediata
  en segundo plano. Otros tipos (share, story_mention, reel, ig_reel, post,
  fallback, sticker sin url…) → mensaje "[adjunto no soportado]".
- **FR-808** La descarga desde `source_url` solo acepta `https` y hosts de
  Meta (`*.fbsbx.com`, `*.fbcdn.net`, `*.cdninstagram.com`) — más la base del
  wa-mock cuando `WA_MOCK_ENABLED` (anti-SSRF). Tope 25 MB, timeout.
- **FR-809** Zernio: un evento con adjunto y sin texto entra como
  "[adjunto no soportado]".

### Salientes

- **FR-810** Messenger: `POST {graph}/{pageId}/messages` multipart con
  `recipient`, `message.attachment` (`image|audio|video|file`),
  `messaging_type` (RESPONSE o MESSAGE_TAG + HUMAN_AGENT) y `filedata`.
- **FR-811** Instagram (Meta): `POST {ig_graph}/{igUserId}/messages` con
  `attachment.payload.url` = **URL firmada temporal** del CRM.
- **FR-812** URL firmada `GET /api/media/out/[token]` (pública, sin sesión):
  token HMAC-SHA256 (clave derivada de `ENCRYPTION_KEY`) sobre
  `organizationId.assetId.exp`, vigencia 10 min, comparación en tiempo
  constante. Solo sirve assets con `direction = "out"` de esa organización
  (`scoped()`), con las mismas cabeceras seguras que FR-814. Token inválido o
  vencido → 404 (sin distinguir).
- **FR-813** El agente IA y `/api/bot/*` **no envían archivos**; una prueba
  unitaria lo fija (el esquema de acciones rechaza adjuntos y el pipeline no
  importa el envío de media).

### Servir archivos

- **FR-814** `GET /api/media/[assetId]` (y `/api/bot/media/[mediaId]`):
  - content-type = el **detectado** por firma (re-verificado al servir: los
    assets viejos guardaron el MIME del remitente);
  - `x-content-type-options: nosniff` +
    `content-security-policy: default-src 'none'; sandbox`;
  - `content-disposition: inline` solo para imagen/audio/video de la lista
    blanca; `attachment` (nombre saneado, `filename*` UTF-8) para el resto;
  - archivo bloqueado → 415 `blocked`; expirado → 410 `expired`.

### Caché de 30 días

- **FR-815** Reloj in-process (patrón `reminder-ticker`): cada hora borra el
  binario de los assets con más de 30 días (`MEDIA_RETENTION_DAYS`, default
  30) y los marca `fetch_status = "expired"`, `storage_path = null`. La fila
  se conserva (marcadores del agente, historial). Idempotente si el archivo
  ya no existe. Tick manual en dev: `POST /api/dev/media/purge`.
- **FR-816** Aviso visible: en el compositor al adjuntar ("Los archivos se
  eliminan del CRM a los 30 días") y en el hilo para los expirados.
- **FR-817** El favicon de marca sigue en `MEDIA_DIR` y **no** se purga.

### Modelo de datos (migración 0020)

- **FR-818** `media_asset`: `direction` (`in|out`, default `in`, backfill
  desde `message.direction`), `source_url` (text, null). `fetch_status` gana
  `expired` y `blocked` (columna text: sin cambio SQL).

## Fuera de alcance

- Antivirus (posible conector opcional futuro).
- Enviar audio/video por Instagram; stickers; grabar audio en el navegador.
- Adjuntos por Zernio (entrada y salida).
- Visión/transcripción para el agente.

## Cambia respecto a specs anteriores

- 003 AC-3 ("disponible tras expirar en Meta") pasa a "disponible durante 30
  días; luego, expirado".
- 014/017: los adjuntos dejan de estar fuera de alcance para Messenger e
  Instagram (Meta).

## Criterios de aceptación (E2E con mocks)

- AC-1 Envío PDF/imagen por WhatsApp, Messenger e Instagram → 200, el mock
  registra el adjunto (Instagram: el mock **descarga** la URL firmada sin
  sesión y obtiene los bytes).
- AC-2 `.exe` (MZ), zip, `.docx` con `vbaProject.bin`, `.doc` OLE → 415 en
  cualquier canal; `.docx` por Instagram → 415 "Instagram solo acepta
  imágenes y PDF".
- AC-3 PNG de 6 MB por WhatsApp → 413.
- AC-4 Entrante WhatsApp con HTML declarado como PDF → `blocked`; GET → 415.
- AC-5 Imagen y PDF entrantes por Messenger e Instagram → visibles y
  descargables; story_mention → "[adjunto no soportado]".
- AC-6 `/api/media/*` responde con `nosniff`, CSP `sandbox`, y `attachment`
  para PDF.
- AC-7 URL firmada adulterada o vencida → 404.
- AC-8 Tick de purga con reloj adelantado 31 días → `expired`, GET → 410, el
  hilo muestra el aviso; el favicon sigue en su lugar.
- AC-9 Gates: typecheck + lint + build + test + E2E encendido y apagado
  (`CHANNELS=off`).
