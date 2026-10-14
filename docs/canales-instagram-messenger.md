# Canales de Instagram y Messenger

Vocero atiende en la misma bandeja los mensajes directos de Instagram y los
mensajes de una Página de Facebook (Messenger), además de WhatsApp. Los dos
canales son opcionales: viven en el código de siempre y se encienden con una
variable ([ADR-001](adr-001-canales-opcionales.md)).

## Qué hacen y qué no

| | Instagram | Messenger |
|---|---|---|
| Recibir texto | ✅ | ✅ |
| Responder texto desde la bandeja | ✅ (máx. 1000 bytes) | ✅ (máx. 2000 caracteres) |
| Agente de IA | ✅ dentro de las 24 h | ✅ dentro de las 24 h |
| Responder entre 24 h y 7 días | Solo un humano, con etiqueta `HUMAN_AGENT` | Igual |
| Después de 7 días | No se puede: el cliente tiene que volver a escribir | Igual |
| Recibir fotos, PDF y otros archivos | ✅ (ver [Adjuntos](#adjuntos)) | ✅ |
| Enviar archivos | ✅ imágenes JPG/PNG y PDF | ✅ imágenes, PDF, Office, TXT/CSV, audio y video |
| Plantillas, ubicación, contactos | ❌ (solo WhatsApp) | ❌ |
| Iniciar la conversación | ❌ la persona escribe primero | ❌ |

Cada canal crea sus propios contactos: una misma persona que escribe por
WhatsApp y por Messenger aparece como dos contactos.

El agente de IA **nunca** responde fuera de las 24 h: la etiqueta de agente
humano es, por política de Meta, solo para personas. Pasado ese plazo la
conversación pasa a un humano.

### Adjuntos

Qué se puede mandar desde el compositor y qué se ve al recibir, por canal
(matriz en `src/lib/outbound-files.ts`; la política que decide el tipo real
de cada archivo, por su contenido y no por la extensión, está en
`src/server/media/file-policy.ts`):

| Canal | Enviar | Recibir |
|---|---|---|
| WhatsApp | Imagen JPG/PNG (5 MB) · PDF, Word, Excel, PowerPoint, TXT, CSV (100 MB) · audio y video (16 MB) · ubicación y contacto | Todo lo anterior + WEBP/GIF y notas de voz |
| Messenger | Imagen JPG/PNG · PDF, Word, Excel, PowerPoint, TXT, CSV · audio y video (25 MB cada uno) | Imagen, video, audio y archivo |
| Instagram (Meta directo) | Imagen JPG/PNG (8 MB) · **solo PDF** como archivo (25 MB) | Imagen, video, audio y archivo |
| Instagram (Zernio) | ❌ | ❌ — un adjunto entra como "[Adjunto no soportado]" |

- **Siempre bloqueado**, en cualquier canal y en ambas direcciones:
  ejecutables, comprimidos (zip, rar, 7z), Office con macros y el formato
  antiguo `.doc/.xls/.ppt`, HTML, SVG y XML. Un archivo recibido que cae aquí
  se ve en el hilo como "Archivo bloqueado por seguridad" y no se puede abrir
  desde el CRM.
- Historias, menciones, reels, publicaciones compartidas y stickers sin
  enlace entran como "[Adjunto no soportado: …]", nunca como un mensaje vacío.
- **Instagram descarga el archivo desde Vocero**: no hay forma documentada
  de subirlo. Vocero le da a Meta una URL firmada temporal
  (`/api/media/out/<token>`, 10 minutos, sin sesión). Por eso
  **`APP_BASE_URL` tiene que ser alcanzable desde Internet** (HTTPS público);
  en `localhost` o detrás de una VPN el envío de archivos por Instagram falla
  y el mensaje queda como no entregado.
- Los archivos (de todos los canales) se guardan en `MEDIA_DIR` como **caché
  de 30 días** (`MEDIA_RETENTION_DAYS`): después se borran solos y el hilo
  muestra "Archivo eliminado — los archivos se guardan 30 días".
- El agente de IA no envía archivos.

## 1. Encender los canales

En las variables del despliegue (runtime, no build):

```bash
CHANNELS=whatsapp,instagram,messenger   # o solo los que uses
```

Con eso aparecen **Ajustes → Instagram** y **Ajustes → Messenger**. Sin la
variable, esas pantallas y sus webhooks responden 404.

La migración `0011_canal_messenger` se aplica sola al arrancar el
contenedor, con el canal encendido o apagado.

## 2. Lo que Meta pide (antes de conectar)

Para ambos canales:

1. Una **app de Meta** de tipo *Negocio* en developers.facebook.com. Puede
   ser la misma que usas para WhatsApp.
2. **Verificación del negocio** en el Business Manager.
3. **Páginas públicas** de política de privacidad, términos y eliminación de
   datos, con sus URLs en *Configuración de la app → Básica*.
4. **App Review** de los permisos de abajo con *Advanced Access*. Sin eso la
   app solo puede escribirle a personas con un rol en la app (útil para
   probar, no para operar).
5. La función **Human Agent** aprobada en App Review, si quieres responder
   entre 24 h y 7 días. Sin ella, Vocero avisa al operador que esa respuesta
   no se puede enviar.

### Instagram (API con inicio de sesión de Instagram)

- La cuenta de Instagram debe ser **profesional** (Empresa o Creador).
- En la app: agrega el producto **Instagram → API con inicio de sesión de
  Instagram**.
- Permisos: `instagram_business_basic`, `instagram_business_manage_messages`.
- Genera el token de la cuenta. Es un token de larga duración que **caduca a
  los 60 días** y hay que renovarlo: cuando caduca, Vocero marca la conexión
  como "reconectar" y pausa los envíos.
- En la app de Instagram del teléfono: *Configuración → Mensajes → Permitir
  acceso a los mensajes* (herramientas conectadas).
- El **IG_ID** del perfil es el `user_id` que devuelve
  `GET https://graph.instagram.com/me?fields=user_id,username` con ese token
  (el mismo que muestra el panel de Meta). Ojo: el campo `id` de esa respuesta
  es OTRO número (el id de la cuenta dentro de tu app) y no sirve aquí.

### Messenger

- Una **Página de Facebook** del negocio, con la app agregada.
- En la app: agrega el producto **Messenger**.
- Permisos: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`.
- Token: el de la **Página**. Lo ideal es generarlo desde un **usuario del
  sistema** en *Business Manager → Usuarios del sistema*, con la Página
  asignada: así no caduca.
- El **id de la Página** está en *Página → Información → Transparencia de la
  página*, o lo devuelve `GET /me?fields=id,name` con el token de la Página.

## 3. Conectar en Vocero

**Ajustes → Instagram**: elige "Meta directo", pega el IG_ID y el token.
**Ajustes → Messenger**: pega el id de la Página y su token.

Antes de guardar, Vocero valida el token contra Meta y rechaza uno inválido o
de otra cuenta. El token se guarda cifrado y en pantalla solo se ven sus
últimos 4 caracteres. Al conectar Messenger, Vocero además suscribe la Página
a la app (`subscribed_apps`); si el token no tiene `pages_manage_metadata`,
la conexión se guarda y la pantalla avisa que falta ese permiso.

## 4. Webhooks

Cada pantalla de Ajustes muestra la URL exacta y el token de verificación.
Tienen esta forma:

| Canal | URL | Campos a suscribir |
|---|---|---|
| Instagram | `https://TU-DOMINIO/api/webhooks/ig/<META_WEBHOOK_VERIFY_TOKEN>` | `messages` |
| Messenger | `https://TU-DOMINIO/api/webhooks/fb/<META_WEBHOOK_VERIFY_TOKEN>` | `messages` |

- El token de verificación que pide Meta es el mismo `META_WEBHOOK_VERIFY_TOKEN`.
- **Firma**: cada entrega se valida con `x-hub-signature-256`.
  - Instagram con inicio de sesión de Instagram firma con la **clave secreta
    de la app de Instagram**, distinta de la de Facebook: ponla en
    `IG_APP_SECRET`.
  - Messenger firma con la clave secreta de la app. Si es la misma app que la
    de WhatsApp basta `META_APP_SECRET`; si es otra, `FB_APP_SECRET`.
  - Sin ningún secreto la firma no se valida y la única barrera es la URL
    secreta. No lo dejes así en producción.

## 5. Probar sin Meta (self-test)

Con los mocks encendidos (ver `specs/001-vocero-core/quickstart.md`) y
`IG_GRAPH_BASE_URL` apuntando al mock:

```bash
IG_GRAPH_BASE_URL=http://localhost:3000/api/dev/wa-mock/graph
CHANNELS=whatsapp,instagram,messenger
```

`pnpm test:e2e` conecta los dos canales, simula DMs firmados
(`/api/dev/wa-mock/channel-inbound`) y recorre respuesta, ventana de 24 h,
etiqueta de agente humano, cierre a los 7 días y fallos del proveedor. El
guion está en [tests/e2e/us-canales.md](../tests/e2e/us-canales.md); los
adjuntos (envío, recepción, bloqueos, URL firmada y caché de 30 días), en
[tests/e2e/us-adjuntos.md](../tests/e2e/us-adjuntos.md).

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| El webhook responde 401 | El secreto de firma no coincide (Instagram usa `IG_APP_SECRET`). |
| El webhook responde 404 | El canal no está en `CHANNELS`, o el segmento de la URL no es el token. |
| Llegan mensajes de Messenger al webhook pero no a la bandeja | La Página no está conectada en Ajustes, o es otra Página. Se ve en el log como `[fb] evento para la Página desconocida`. |
| No llega nada de Messenger | La Página no está suscrita a la app: reconecta con un token que tenga `pages_manage_metadata`. |
| "…necesita la función Human Agent…" | Meta aún no aprueba *Human Agent* para la app. Dentro de las 24 h se responde normal. |
| Instagram pide reconectar cada ~60 días | El token de Instagram caduca: genera otro y pégalo de nuevo. |
| Un archivo por Instagram queda "no entregado" ("url no accesible") | Meta no pudo descargar la URL firmada: `APP_BASE_URL` no es público, o pasó más de 10 minutos. |
| "Instagram solo acepta imágenes (JPG/PNG) y PDF" | Es un límite de Instagram: manda el Word/Excel como PDF. |
| Error de permisos al enviar por Instagram | El host debe ser `graph.instagram.com`, no `graph.facebook.com` (Vocero ya lo hace; revisa `IG_GRAPH_BASE_URL`). |
