# 020 — Origen de leads (de qué anuncio vino cada cliente)

> Estado: **plan para aprobación del dueño** (2026-10-15). No se implementa
> nada hasta que el dueño lo apruebe y responda las decisiones de la sección 2.

## 1. Objetivo

Que el equipo vea **de qué anuncio o reel promocionado llegó cada lead** y que
el dueño mida **cuántos leads y ventas trae cada anuncio**, en los tres canales.

- **Punto 2 (mostrar):** tarjeta "Anuncio de origen" en la ficha del contacto
  y en el lead del pipeline, etiqueta en la Bandeja, filtro "Anuncios", fuente
  del contacto deducida como "Anuncio" y reporte **Reportes → Anuncios**.
- **Punto 3 (capturar IG/Messenger):** leer el anuncio de origen que Meta manda
  en Messenger (Click-to-Messenger) e Instagram (Click-to-Direct).
- **Fuera de alcance:** lo orgánico (punto 4, pospuesto: que la IA pregunte
  "¿cómo se enteró?"); las señales orgánicas de Instagram (respuesta a una
  historia, reel compartido) se dejan para ese punto. Gasto/costo por anuncio
  (requiere Marketing API, `ads_read`) tampoco entra.

## 2. Decisiones que necesito del dueño

| # | Decisión | Recomendación |
|---|---|---|
| D1 | Si un cliente vuelve por **otro** anuncio, ¿cuál cuenta? | **El primero** (first-touch): es lo que ya guarda la tabla y lo que usa el reporte a Meta |
| D2 | ¿El reporte incluye **monto ganado por anuncio**? | **Sí**: leads, ganados y monto ganado por anuncio (el monto ya existe en el lead) |
| D3 | ¿El equipo puede **corregir a mano** la fuente del contacto? | **Sí**: hoy no se puede editar; la deducida ("Anuncio") se muestra como deducida y se puede sobrescribir |
| D4 | ¿Quién ve qué? | Tarjeta, etiqueta y filtro: **todos los roles**. Reporte: **solo Propietario** |

## 3. Qué ya existe (investigado el 2026-10-15)

- **WhatsApp:** con `ATRIBUCION=on` (activa en prod desde el 15-oct) cada
  referral CTWA se guarda en `ad_attribution` (ID del anuncio, titular, texto,
  enlace, tipo de medio, `ctwa_clid`, payload `raw`), uno por conversación, gana
  el primero. Hoy **solo lo lee la IA** (contexto) y la bitácora de Ajustes →
  Anuncios; **ninguna pantalla del equipo lo muestra**.
- **Aún no hay datos reales**: ningún lead ha llegado por anuncio desde que se
  encendió la captura. El diseño se basa en la documentación de Meta.
- `contact.source` existe (Anuncio, Orgánico, Referido, Conocido, Otro) pero
  solo se llena al dar de alta un contacto a mano; el PATCH no la acepta.
- Reportes ya tiene la pestaña **"Anuncios"** marcada "Próximamente".
- **Upstream** (kevinrivm/vocero-crm) tiene 018 "anuncio de origen" + 019
  "resultados" (sección de anuncios). Se **adaptan sus módulos puros**
  (`referral.ts`, `creativo.ts`, componente de tarjeta, consultas SQL del
  reporte) en vez de traer su pila de analytics completa.
- Messenger e Instagram **ignoran hoy los referrals** (los eventos sin
  `message` se descartan).

## 4. Diseño

### 4.1 Captura (núcleo)
- **La captura del origen deja de depender de la bandera** (como upstream):
  el anuncio de origen es dato interno. Solo `ctwa_clid` y el reporte a Meta
  (CAPI) siguen detrás de `ATRIBUCION`. *Cambio explícito en
  `src/server/inbox/ingest.ts:455`.*
- Normalizador por canal → un `AnuncioDeOrigen` común
  (`src/server/attribution/referral.ts`, puro, con listas blancas y topes de
  tamaño):
  - WhatsApp: `source_id`, `source_type`, `source_url`, `headline`, `body`,
    `media_type`, `image_url`/`thumbnail_url`, `ctwa_clid`.
  - Messenger / Instagram: `ad_id` → id, `ads_context_data.ad_title` →
    titular, `photo_url`/`video_url` → miniatura y tipo, `post_id` → enlace
    cuando se pueda armar; `ref` y el payload completo a `raw`.
- **Miniatura del anuncio:** se descarga **una vez por anuncio** del CDN de
  Meta (solo hosts de Meta, https, ≤300 KB, JPEG/PNG/WebP/GIF) y se guarda
  como adjunto propio. **Se excluye de la purga de 30 días** (la URL de Meta
  caduca y no se podría recuperar).
- **Migración 0022** (generada con `pnpm db:generate`, sin `"public"`
  cableado): `ad_attribution.image_asset_id` (FK a `media_asset`, set null) +
  índice `(organization_id, source_id)`.

### 4.2 Pantallas (punto 2)
- **Ficha del contacto (Bandeja) y lead del pipeline:** tarjeta "Anuncio de
  origen" con miniatura, titular, texto, "con video", fecha del primer mensaje,
  ID del anuncio y "Ver anuncio" (enlace https).
- **Bandeja:** etiqueta "Anuncio · <titular>" en la fila; **filtro "Anuncios"**
  con contador.
- **Fuente del contacto:** si no fue capturada a mano y hay anuncio de origen →
  "Anuncio" (marcada como deducida). Se vuelve **editable** (D3).
- **Reportes → Anuncios** (Propietario), con el marco existente de reportes
  (rango, zona horaria, bloques con timeout, excluye Laboratorio):
  - Por fuente: conversaciones, leads, ganados y % de cierre.
  - Por anuncio (con miniatura y titular): leads, ganados, % y **monto ganado**
    (D2), máximo 50 filas, ordenado por leads.

### 4.3 Messenger e Instagram (punto 3)
- **Messenger:** leer `message.referral` (hilo nuevo, campo `messages`),
  `referral` suelto (hilo existente, campo `messaging_referrals`) y
  `postback.referral` (botón "Empezar", campo `messaging_postbacks`).
  - Un `referral` suelto se asocia a la conversación existente **sin crear
    mensaje**; si el contacto no existe aún, se guarda pendiente y se aplica
    con su primer mensaje.
  - Suscripción a nivel Página: el CRM pasa a pedir `messages`,
    `messaging_referrals` y `messaging_postbacks` al conectar; se re-suscribe
    la Página ya conectada.
  - **Acción del dueño:** marcar esos dos campos en el webhook de Messenger de
    la app (panel de Meta).
- **Instagram:** leer `message.referral` (Click-to-Direct llega por
  `messages`, ya suscrito). Sin cambios de suscripción.

## 5. Fases y orden

| Fase | Contenido | Estimado |
|---|---|---|
| A | Captura sin bandera + miniatura + migración 0022 + tarjeta (ficha y lead) + etiqueta y filtro en Bandeja + fuente deducida/editable | 1–2 días |
| B | Reportes → Anuncios (por fuente y por anuncio, con monto) | ~1 día |
| C | Captura en Messenger e Instagram + suscripciones | ~0.5–1 día |

Cada fase: gate técnico + unit tests (normalizadores, reglas de miniatura) +
**E2E extendido** con el mock (referral de WhatsApp, Messenger e Instagram,
miniatura, filtro, reporte, purga que no borra miniaturas). Se despliega cada
fase con autorización del dueño.

## 6. Verificación real — límites honestos

- **Solo un clic real en un anuncio** genera el referral; Meta no tiene
  eventos de prueba. WhatsApp se puede comprobar con el primer cliente que
  llegue de un anuncio de Click-to-WhatsApp.
- **Messenger e Instagram:** con acceso estándar Meta solo entrega mensajes de
  personas con rol en la app. Hasta que **App Review apruebe** los permisos y
  haya un anuncio real de Messenger/Instagram, la fase C queda **probada solo
  con el mock**.
- No se sabe aún qué campos manda Meta en la práctica (los docs de Instagram
  no listan `post_id` con claridad): el normalizador es tolerante y guarda el
  payload completo en `raw`.

## 7. Riesgos

- **Merges de upstream:** se adapta código de upstream 018/019; la migración
  usa nuestro número (0022) — al traer upstream, su 0014 se omite.
- **Otra sesión trabaja en `main`:** esta feature va en la rama
  `020-origen-de-leads` (worktree aparte) y se integra al final de cada fase.
