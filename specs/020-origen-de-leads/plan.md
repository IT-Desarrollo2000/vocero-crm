# 020 — Origen de leads (de qué anuncio vino cada cliente)

> Estado: **decisiones aprobadas por el dueño** (2026-10-15): D1 el primero,
> D2 sí, D3 sí, D4 de acuerdo, y rediseño de filtros = "Vistas + botón
> Filtros" (sección 4.4).
>
> **Fase A: implementada y verificada (2026-10-16)** en la rama
> `020-origen-de-leads` — sin desplegar, esperando revisión/merge del dueño.
> Detalle, decisiones de implementación y resultados en la sección 8 y en
> [tasks.md](tasks.md). Fases B y C: pendientes.

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

### 4.4 Rediseño de los filtros de la Bandeja (pedido del dueño)
Hoy: 6 pastillas excluyentes en 3 renglones + selector de etapa + canales en
el encabezado. Nuevo diseño (elegido por el dueño):
- **Un renglón de vistas** (excluyentes, con contador): Todas · No leídas ·
  Mías · Atención humana.
- **Botón "Filtros"** (con número de filtros activos) que abre un panel con
  filtros **combinables** entre sí y con la vista: Canal (WhatsApp/Instagram/
  Messenger), Etapa, **Origen** (Todos / De anuncio / Sin anuncio, con
  contador), Sin asignar, Por cerrar.
- **Filtros activos** como etiquetas removibles (x) + "Limpiar".
- Los contadores de canal del encabezado se quedan como atajo al filtro Canal.
- Móvil: el panel abre como hoja inferior; el estado de filtros vive en la URL
  (para compartir/recargar).
- Afecta: `src/server/inbox/list-query.ts` (parseo de varios filtros),
  `queries.ts` (combinar condiciones + contadores), `conversation-list.tsx`,
  `list-state.ts`. E2E: combinaciones (p. ej. No leídas + De anuncio + Etapa)
  y contadores coherentes.

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
| A | Captura sin bandera + miniatura + migración 0022 + tarjeta (ficha y lead) + etiqueta en Bandeja + fuente deducida/editable + **rediseño de filtros con Origen** | 2–3 días |
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

## 8. Fase A — cómo quedó (2026-10-16)

### 8.1 Captura y miniatura
- `src/server/attribution/referral.ts` (puro): `AnuncioDeOrigen` común
  (sourceId, sourceType, sourceUrl, headline, body, mediaType, ctwaClid,
  imageUrl, raw) + `anuncioDeWhatsapp` (lista blanca de claves, topes, solo
  http(s)) + `sinIdentificadorDeClic`. La fase C añade `anuncioDeMessenger` /
  `anuncioDeInstagram` con la MISMA salida (mapeo documentado en el archivo).
- `ingest.ts` guarda el anuncio SIEMPRE; `anuncioParaGuardar` (store.ts)
  quita el `ctwa_clid` (columna y `raw`) si `ATRIBUCION` está apagada. El
  docstring de `flag.ts` lo explica para que nadie "corrija" la ingesta.
- `src/server/attribution/creativo.ts`: descarga acotada (hosts de Meta,
  https, sin puerto/credenciales, ≤3 redirecciones revalidadas, 5 s, 1
  reintento, ≤300 KB, JPEG/PNG/WebP/GIF). **Desviación sobre upstream:** los
  bytes pasan por `inspectFile` (la firma decide el tipo, política 018) y el
  origen del mock es el de `source-fetch.ts` (origin de `APP_BASE_URL` bajo
  `/api/dev/wa-mock/`, solo con mocks). Una por `source_id`; reparación
  perezosa al abrir el contacto con freno de 10 min por anuncio.
- Purga: `purgeableCondition` excluye todo asset referenciado por
  `ad_attribution.image_asset_id` (por la FK, no por `payload.origen`: un
  huérfano sí se purga).
- `/api/media/[assetId]`: el Vendedor ve la miniatura si ve alguna
  conversación (no Laboratorio) que llegó por ese anuncio (D4).
- Migración `0022_anuncio_de_origen` generada con `pnpm db:generate` y
  editada a mano para ser re-ejecutable y sin esquema cableado (como 0020/0021).

### 8.2 Pantallas y API
- `GET /api/contacts/[id]` → `anuncio` (`AnuncioDto`: el primero del contacto,
  D1; `imageUrl` = `/api/media/<id>`; `hasCtwaClid` sin el valor y solo con la
  bandera). `PATCH` acepta `source` (enum o `null` = volver a la deducida).
- `effectiveSource(stored, llegoPorAnuncio)`: deduce "Anuncio" si no hay
  captura y el primer origen no es publicación. También en la lista de
  contactos (en lote). El contexto del agente y `/api/bot/context` siguen sin
  deducir (fuera del alcance de A).
- `ConversationDto.anuncio = {headline, sourceType}` por LEFT JOIN de
  `ad_attribution` por (org, conversación): llega en la lista, en `?ids=`
  (lo que la Bandeja pide tras el SSE) y en los PATCH de conversación.
- UI: `src/components/anuncio-origen.tsx` (tarjeta + etiqueta), en el panel
  del contacto (sección "Origen" entre la etapa y la Ficha, con el selector de
  fuente) y en el cajón del trato. Etiqueta "Anuncio · <titular>" /
  "Publicación · …" en su propio renglón de la fila.

### 8.3 Filtros de la Bandeja (4.4)
- Vistas (`?filter=`): `all | unread | mine | human`. Filtros combinables:
  `channel`, `stage`, `origin=ad|none`, `unassigned=1`, `closing=1`. Los
  valores viejos `filter=unassigned|closing` se traducen al filtro nuevo (en
  servidor y en la URL de la página).
- **Origen por conversación**: "De anuncio" = la conversación tiene anuncio y
  no es `source_type=post`; "Sin anuncio" = el resto (publicaciones
  incluidas, coherente con la fuente deducida). La tarjeta y la fuente miran
  al contacto (primer anuncio, D1); en WhatsApp es lo mismo (una conversación
  por contacto y canal).
- **Semántica de contadores (facetada):** cada número es lo que verías al
  elegir esa opción dejando todo lo demás fijo.
  - Vistas (Todas/No leídas/Mías/Atención humana) = base ∧ todos los filtros
    del panel ∧ esa vista (la vista activa se reemplaza, no se suma).
  - Origen (De anuncio/Sin anuncio), Canal (encabezado y panel), Sin asignar,
    Por cerrar = base ∧ vista activa ∧ los demás filtros ∧ esa opción.
  - Badge de no leídas del menú/título: solo visibilidad (sin cambios).
  - Sin vista ni filtros nuevos, coincide con el contrato 06-0. Cambio
    visible: los contadores de canal del encabezado ahora respetan la vista.
- Estado en la URL de la página (`history.replaceState`, conserva
  `?contact=`); la búsqueda de la URL se pinta en la caja al recargar.
- Panel: desplegable dentro de la columna en escritorio, hoja inferior en
  móvil; Esc / velo / "Listo" cierran; "Limpiar" quita los filtros del panel
  y deja la vista. Sin equipo (Propietario solo) no aparecen "Mías" ni "Sin
  asignar".

### 8.4 Verificación
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test` verde
  (135 archivos, 1609 pruebas).
- E2E con BD aislada (Docker :5433, BD reseteada entre corridas):
  `e2e-selftest` 383/383 (módulos encendidos) y 202/202 (CHANNELS, AGENDA y
  ATRIBUCION apagados); `e2e-search-filters` 55/55; `e2e-bandeja-paginacion`
  102/102; `e2e-responsive` 54/54; `e2e-alertas` 53/53.
- Verificación real: imposible hasta que llegue un clic real de un anuncio
  CTWA (sección 6).
