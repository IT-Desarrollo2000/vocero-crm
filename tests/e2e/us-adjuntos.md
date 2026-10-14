# E2E — Adjuntos seguros en WhatsApp, Messenger e Instagram (018)

Guion de comportamiento observable para
[specs/018-adjuntos-seguros/spec.md](../../specs/018-adjuntos-seguros/spec.md).
Automatizado en dos partes:

- **API** — `adjuntosChecks()` de `scripts/e2e-selftest.mjs` (corre AL FINAL
  del self-test: su último paso expira todos los adjuntos de la BD).
- **Navegador** — `scripts/e2e-adjuntos-ui.mjs` (Playwright): lo que ve el
  operador en el hilo y en el compositor.

**Preparación**: app con `WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` e
`IG_GRAPH_BASE_URL` → wa-mock graph, `APP_BASE_URL` = la URL de la app (el
mock de Instagram DESCARGA la URL firmada desde ahí) y BD migrada (0020).
Con `CHANNELS` sin `instagram`/`messenger`, sus secciones se omiten y la de
WhatsApp corre igual. En local, BD aislada (`.env.e2e`, Postgres en :5433).

```bash
node --env-file=.env.e2e scripts/e2e-selftest.mjs
node --env-file=.env.e2e scripts/e2e-adjuntos-ui.mjs   # reinicia el server antes (limitador de login)
```

Cada caso manda **bytes reales**: el tipo lo decide la firma del contenido,
no la extensión ni el MIME declarado. El mock sirve bytes según el id
(`media-file/<id>` y `cdn/<id>`): `html` → HTML con `<script>`, `exe` → `MZ…`,
`pdf` → PDF válido, `expired` (solo CDN) → 404, otro → JPEG 1×1. El MIME
DECLARADO es `application/pdf` si el id dice `pdf`: `…-html-pdf` es "HTML que
dice ser PDF".

---

## AC-1 — Enviar PDF e imagen por los tres canales

1. WhatsApp: PDF real (`%PDF-1.4…`), JPEG real y `.docx` limpio → **201**;
   Graph recibe el PDF como `document` (con su nombre) y el JPEG como `image`.
2. Messenger: imagen y PDF → 201; el outbox registra
   `attachment.channel = "messenger"` con los bytes exactos (multipart
   `filedata`) y el nombre `cotizacion.pdf`. `.docx` limpio → 201.
3. Instagram (Meta directo): imagen y PDF → 201; el outbox registra
   `fetchedStatus = 200` y `fetchedBytes` = los bytes enviados: el mock
   descargó la **URL firmada sin sesión**, como lo hace Meta.
4. El pie (caption) en Messenger/Instagram sale como **un texto aparte**, y
   así queda en el hilo; la imagen enviada queda `sent` con su asset
   disponible.

## AC-2 — Lo que se rechaza antes de tocar a Meta

1. WhatsApp → **415** con razón clara y nada llega a Graph:
   `.exe` (`MZ`), `.exe` renombrado a `.pdf`, `.zip` genérico, `.docx` con
   `word/vbaProject.bin` ("macros"), `.doc` OLE (`D0 CF 11 E0…`, "guárdalo
   como .docx").
2. Instagram: `.docx` limpio → 415 "Instagram solo acepta imágenes (JPG/PNG)
   y PDF".
3. Messenger e Instagram: `.exe` → 415.

## AC-3 — Tope por canal

1. WhatsApp: PNG real (cabecera PNG + relleno) de 6 MB → **413** con "5 MB".

## AC-4 — Entrante bloqueado en WhatsApp

1. `POST /api/dev/wa-mock/inbound` con `mediaId: media-e2e-html-pdf-…`
   (HTML que dice ser PDF) → el mensaje queda `fetchStatus: "blocked"` con
   `blockedReason` que menciona HTML. El binario no se guarda.
2. `GET /api/media/<asset>` → **415 `blocked`**, y el cuerpo jamás trae el HTML.
3. Un PDF entrante real → `available`, MIME `application/pdf`.

## AC-5 — Entrantes por Messenger e Instagram

Por cada canal, `POST /api/dev/wa-mock/channel-inbound` con `attachments`
apuntando al CDN del mock:

1. Imagen (`cdn/foto-…`) → `available`; GET → 200 `image/jpeg` **inline**.
2. PDF (`type: "file"`, `cdn/cot-pdf-…`) → `available`; GET → 200
   **attachment**.
3. Ejecutable (`cdn/manual-exe-…`) → `blocked`; GET → 415.
4. URL del CDN caducada (`cdn/foto-expired-…`, 404) → `failed`, el mensaje
   se conserva; GET → 410.
5. `story_mention` → un mensaje con "[Adjunto no soportado: …]", nunca vacío.

## AC-6 — Cómo se sirve un archivo

1. Toda respuesta de `/api/media/*` lleva `x-content-type-options: nosniff`
   y `content-security-policy` con `sandbox`.
2. PDF → `content-disposition: attachment; filename="…"`; imagen → `inline`.

## AC-7 — URL firmada

1. `/api/media/out/<basura>` y un token con forma válida pero firma falsa →
   **404**.
2. La URL que usó Instagram, sin sesión y vigente → 200 con nosniff/sandbox.
3. Adulterada (un carácter de la firma, el ÚLTIMO carácter de la firma, un
   carácter del payload) → **404**.

## AC-8 — Caché de 30 días (al final: expira todo)

1. Se sube un favicon de marca (`PUT /api/settings/branding/favicon`).
2. `POST /api/dev/media/purge {}` (reloj de hoy) → `expired: 0`.
3. `POST /api/dev/media/purge {"advanceDays": 31}` → `expired > 0`; el PDF
   antes disponible → GET **410 `expired`**; el mensaje sigue en el hilo con
   `fetchStatus: "expired"`. Un `blocked` sigue `blocked`: nunca tuvo
   archivo, y purgarlo solo borraría el aviso "bloqueado por seguridad".
4. Segunda vuelta → `expired: 0` (idempotente).
5. `GET /api/branding/favicon` devuelve el mismo PNG: el favicon no se purga.

## Lo que ve el operador (Playwright, `scripts/e2e-adjuntos-ui.mjs`)

1. La foto del cliente se ve renderizada en el hilo (`naturalWidth > 0`).
2. El PDF es una tarjeta con nombre, tipo ("PDF"), tamaño y enlace de
   descarga (`href` a `/api/media/…` + `download`).
3. El HTML disfrazado: "Archivo bloqueado por seguridad" + la razón, **sin
   ningún enlace** al archivo.
4. La descarga fallida: "No disponible (expiró en la plataforma)".
5. Una imagen cuyo GET falla en el navegador: "No se pudo cargar la imagen",
   no un icono roto.
6. Una foto que llega con el hilo abierto pasa de "descargando…" a visible
   sin recargar.
7. Compositor (WhatsApp): el `<input type=file>` lleva el `accept` del canal
   (`outboundFiles.accept`), el clip explica qué acepta, hay ubicación y
   contacto. Elegir `virus.exe` muestra el error del canal y no lo adjunta;
   un PDF muestra la tarjeta con "Los archivos se eliminan del CRM a los 30
   días." y al enviarlo aparece en el hilo como tarjeta.
8. Tras la purga con el reloj +31 días: los adjuntos muestran "Archivo
   eliminado — los archivos se guardan 30 días", sin imágenes ni enlaces.

## En vivo (producción)

1. Instagram necesita que `APP_BASE_URL` sea HTTPS público: mandar un PDF a
   la cuenta de pruebas y verificar que llega al teléfono.
2. Desde el teléfono, mandar una foto por Messenger y por Instagram → se ve
   en el hilo del CRM.
