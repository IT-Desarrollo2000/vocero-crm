# 11 — Leads externos: formulario web (futuramexico.com/contacto) y FastApp

> Estado: **aprobada por el dueño 2026-10-19 (D-11-1…9 según recomendación)** —
> **lado CRM hecho en la rama `011-leads-externos` (2026-10-19), rebasada sobre
> `main` con 021 y 022, lista para el merge** (sin mergear); lado ERP
> pendiente (requiere OK) · Prioridad: media · Esfuerzo: M (CRM) + S (ERP) ·
> Migración: sí, **`0024_leads_externos`** (commiteada; la `0023` es de 022) ·
> Bandera: sí, `LEADS_EXTERNOS` (apagada por defecto, ADR-001)
>
> Se apoya en 00 (clave en Ajustes, solo Propietario), 04 (ficha), 05 (alerta),
> 09 (entra sin asignar) y 020 (fuente del contacto).

## 0. Lo que hay hoy en el ERP (proyecto Supabase «Agencia-ev», revisado 2026-10-19)

Todos los leads del ERP viven en una sola tabla, `public.leads`, y entran por
dos funciones públicas:

| Entrada | Función (desplegada) | `source` | Leads (total / 30 días) | Teléfono | Email |
|---|---|---|---|---|---|
| Formulario de futuramexico.com/contacto | `create-public-lead` v3 | `website` | 37 / 10 | 37/37 de 10 dígitos | siempre |
| FastApp (promotores con enlace/token por sucursal, capturan prospectos en campo) | `create-fast-app-lead` v5 | `fast_app` | 37 / 7 | 37/37 de 10 dígitos (la función solo exige teléfono **o** email, y no limpia el formato) | 11/37 |
| Captura manual en el ERP | — | `walk_in`, `social_media` | 10 / 3 | casi siempre | casi nunca |

- Volumen bajo: **~1 lead externo al día** sumando ambas fuentes.
- Triggers en `leads`: `trg_lead_code` (código `LEAD-…`), `trg_auto_assign_lead`
  (asigna vendedor **del ERP**), `trigger_notify_new_public_lead`,
  `trg_audit_leads`.
- Extensiones disponibles y en uso: **`pg_net`** (el cron `workshop-sync-auto`
  ya llama una función con `net.http_post` cada 5 min), **`pg_cron`**,
  **`supabase_vault`**.
- La versión desplegada de `create-public-lead` (v3, sin cambios desde mayo)
  **no es igual** a la del repo `agenciaev`; además la carpeta local está
  ligada a otro proyecto (`ulkdur…`), no al real (`vqfctefthnqjwryhkbna`).
  Razón de más para **no** tocar las funciones (D-11-1).
- FK útiles para armar el payload: `branch_id → branches`,
  `brand_id → vehicle_brands`, `model_id → vehicle_models`,
  `fast_app_token_id → fast_app_tokens`; FastApp guarda además
  `fast_app_creator` (nombre del promotor).

## 1. Especificación

### Problema / objetivo

Los leads del formulario web y de FastApp quedan solo en el ERP. El vendedor
que vive en la Bandeja del CRM no los ve, no puede contactarlos por WhatsApp
desde ahí, y cuando el prospecto escribe después por WhatsApp no hay nada que
diga «este ya dejó sus datos pidiendo X».

Objetivo: cada lead nuevo del formulario web o de FastApp aparece en el CRM
**en segundos** como una conversación en la Bandeja (sin asignar, con alerta),
con contacto identificado por teléfono y lead en Seguimiento, para que un
vendedor lo contacte con una plantilla. Si el prospecto escribe luego por
WhatsApp, cae en **el mismo contacto y la misma conversación**.

### Alcance (incluye) / Fuera de alcance

Incluye:

- Endpoint de entrada `POST /api/intake/lead`, autenticado con clave secreta
  por organización, idempotente por `lead_id` del ERP, genérico por `origin`
  (`website` | `fast_app`).
- **Ajustes → Leads externos** (solo Propietario): generar / rotar / revocar la
  clave, últimos 4, último lead recibido por origen.
- Contacto (upsert por teléfono), conversación sin asignar, lead en
  Seguimiento, fuente del contacto, y una **tarjeta del lead** en el hilo.
- Lado ERP: un trigger `AFTER INSERT` en `leads` que reenvía con `pg_net`, más
  un cron de conciliación (fase aparte, requiere OK).

Fuera de alcance (v1):

- Responder automáticamente (plantilla de bienvenida o agente IA): el vendedor
  envía la plantilla a mano. Candidato a fase 2.
- Leads sin teléfono (posible en FastApp aunque hoy no hay ninguno): no se
  reenvían; sin teléfono no hay identidad de WhatsApp.
- Leads capturados a mano en el ERP (`walk_in`, `social_media`): ampliar el
  filtro del trigger es una línea, pero no en v1 (D-11-8).
- Sincronizar de vuelta al ERP (estado del lead, vendedor asignado).

### Historias de usuario

1. Como **Vendedor**, cuando alguien llena el formulario web o un promotor
   registra un prospecto en FastApp, veo aparecer una conversación nueva en la
   Bandeja (sin asignar) con aviso, abro la tarjeta con lo que pidió y le mando
   una plantilla.
2. Como **Propietario**, en Ajustes genero la clave, la guardo en el ERP y veo
   que llegó el último lead de cada origen; si se filtra, la roto.
3. Como **Vendedor**, cuando ese prospecto me escribe por WhatsApp días
   después, su mensaje cae en la misma conversación y arriba veo la tarjeta.
4. Como **Propietario**, en Reportes veo cuántos contactos vienen del sitio
   web y cuántos de promotores.

### Requisitos funcionales

- **RF-1 Autenticación.** Header `X-API-Key` comparado en tiempo constante con
  la clave de la organización (cifrada en BD con `encryptSecret`). Sin clave
  configurada o incorrecta → 401 sin detalle. Bandera apagada → 404.
- **RF-2 Límite de tasa.** Dos cubetas con `checkRateLimit`: una por IP que
  cuenta SOLO intentos fallidos (sin clave o clave incorrecta, 20/min) y una
  global (120/min) que cuenta SOLO peticiones ya autenticadas; cualquiera
  excedida → 429 sin detalle. Orden: bandera → ¿IP bloqueada por fallos? →
  organización + clave (fallo: cuenta en la IP, 401) → global → OK. Así
  alguien sin clave no agota el cupo global ni deja al ERP en 429, y el ERP
  (todo llega desde la IP de salida de Supabase, `pg_net`) no llena la
  cubeta de fallos mientras use la clave correcta. (El antispam del
  visitante sigue en el ERP: reCAPTCHA y 5/h por IP en `create-public-lead`.)
- **RF-3 Contrato de entrada** (Zod, campos desconocidos ignorados):

  | Campo | Req. | Nota |
  |---|---|---|
  | `lead_id` | sí | uuid del lead en el ERP; llave de idempotencia |
  | `origin` | sí | `website` \| `fast_app` |
  | `lead_code` | no | `LEAD-{SUC}-{AÑO}-{NNNN}` |
  | `first_name`, `last_name` | no / no | sin nombre el lead NO se rechaza: el contacto conserva su nombre de respaldo (el teléfono) y la tarjeta dice «(sin nombre)» |
  | `phone` | sí | 10 dígitos MX, `52…`, `521…`, `+52…`, con o sin espacios |
  | `email` | no | |
  | `notes` | no | mensaje libre del prospecto / nota del promotor |
  | `vehicle` | no | texto ya resuelto («Marca Modelo»), no ids |
  | `branch` | no | nombre de la sucursal |
  | `promoter` | no | `fast_app_creator` (solo FastApp) |
  | `budget_min`, `budget_max`, `payment_method`, `trade_in` | no | |
  | `utm_source`, `utm_medium`, `utm_campaign` | no | |
  | `created_at` | no | ISO; si falta, es ilegible o viene más de 5 min en el futuro, hora de llegada (las fechas pasadas se respetan) |

- **RF-4 Teléfono.** Se quitan los no-dígitos; 10 dígitos → `52` + 10; `521` +
  10 → `52` + 10 (`normalizeMx`); `52` + 10 tal cual; otra cosa → 422
  `invalid_phone`. Así coincide con el `from` de Meta cuando el prospecto
  escribe. **No** cambia la regla de `POST /api/contacts` (que exige lada a
  propósito): la suposición «10 dígitos = México» es local a este endpoint.
- **RF-5 Contacto.** `getOrCreateContactByIdentity` (reconcilia, reactiva
  archivados, solo reemplaza nombres de respaldo). Si el contacto no tiene
  fuente capturada, se asigna la del origen (D-11-5); si ya tenía, no se toca.
- **RF-6 Conversación.** `getOrCreateConversation` (la real del contacto o una
  nueva **sin asignar**, D-09-2). **No** toca `lastInboundAt`: la ventana de
  24 h sigue cerrada y el compositor obliga a plantilla (`replyModeFor`).
- **RF-7 Tarjeta del lead.** Un mensaje `direction:"in"`, `type:"lead_intake"`,
  `waMessageId = "intake:<lead_id>"` (UNIQUE → idempotencia), `status:
  "delivered"`, `text` = resumen legible, campos estructurados para pintar la
  tarjeta. Sube `unreadCount` y `lastMessageAt`. Publica `message.new` +
  `conversation.updated` → alerta (05) y globo sin plomería nueva.
- **RF-8 Lead.** `createLeadForContact` si el contacto no tiene lead abierto.
- **RF-9 Ficha.** Email (y vehículo/sucursal si el negocio tiene esos campos)
  vía `upsertFicha` con fuente nueva `"externo"`, **respetando ediciones
  humanas** (D-04-4). Lo demás queda en la tarjeta.
- **RF-10 Agente.** El endpoint **nunca** dispara `maybeRunAgentTurn` (con la
  ventana cerrada escalaría con motivo `ventana`: alerta engañosa y escalación
  falsa en métricas). Cuando el prospecto escriba, el agente ve la tarjeta
  etiquetada en su historial («[Lead del sitio web] …» / «[Lead de promotor]
  …»), no como si el cliente lo hubiera dicho en el chat.
- **RF-11 Idempotencia.** El mismo `lead_id` otra vez → 200
  `{ duplicate: true }`, sin segunda tarjeta ni alerta. Esto es lo que permite
  el cron de conciliación del ERP.
- **RF-12 Respuesta.** 201 `{ contactId, conversationId, created }`. Errores
  `{ error: code }`. Nunca se loguea la clave ni el payload (solo `lead_id`,
  `origin` y los últimos 4 del teléfono).

### Permisos por rol

| Superficie | Propietario | Vendedor | Sin sesión |
|---|---|---|---|
| `POST /api/intake/lead` | — | — | con clave (`X-API-Key`) |
| `GET/PUT/DELETE /api/settings/intake` | sí | 403 | 401 |
| Ajustes → Leads externos | sí | no se muestra | — |
| Ver la conversación creada | sí | sí (sin asignar, D-09) | — |

### Criterios de aceptación

1. Con `LEADS_EXTERNOS=on` y clave generada, un POST válido (`website` y
   `fast_app`) crea contacto (`52` + 10), conversación sin asignar, lead en
   Seguimiento y la tarjeta en el hilo; la Bandeja abierta lo muestra en vivo
   y una pestaña en segundo plano recibe la alerta.
2. Repetir el mismo `lead_id` no crea otra tarjeta ni alerta.
3. Clave incorrecta → 401; bandera apagada → 404 (endpoint y pestaña);
   teléfono inválido → 422; exceso → 429.
4. El compositor de esa conversación ofrece solo plantilla.
5. El agente no corre ni escala al recibir el lead.
6. Un mensaje real de WhatsApp desde ese número cae en la **misma**
   conversación y desde ahí la ventana se abre con normalidad.
7. Las métricas del agente (02) no cambian por una tarjeta de lead.
8. Un Vendedor no ve la pestaña ni puede llamar a su API.
9. ERP: si el CRM está caído, el formulario y FastApp responden igual al
   usuario (el reenvío es asíncrono) y el lead llega en la siguiente
   conciliación.

### Casos borde y degradación

- El mismo teléfono llega por web y por FastApp: un contacto, una
  conversación, dos tarjetas.
- Contacto que ya conversa por WhatsApp: la tarjeta se agrega a su
  conversación; si su ventana está abierta, sigue abierta.
- Contacto archivado: se reactiva. Nombre real existente: se conserva.
- `/api/bot/typing` toma el último entrante con `waMessageId` para marcar leído
  en Meta: debe **ignorar** `intake:%` o el «escribiendo…» falla.
- Clave rotada: la vieja deja de valer al instante; el ERP recibe 401 (visible
  en `net._http_response`) hasta que se actualice el secreto en Vault.

## 2. Plan técnico

### Estado actual en el CRM (lo que ya existe)

- Upsert de contacto con reconciliación: `getOrCreateContactByIdentity`
  (`src/server/inbox/identity.ts`), `getOrCreateConversation`
  (`src/server/inbox/ingest.ts`), `createLeadForContact`
  (`src/server/inbox/lead-activity.ts`), `upsertFicha`
  (`src/server/bot/ficha.ts`).
- Precedente de «contacto + conversación sin mensaje real»:
  `registrarOrigenSinMensaje` (020 fase C), que **no** alerta — por eso aquí va
  una tarjeta como mensaje.
- Secretos por organización con «últimos 4»: `capiSettings` +
  `src/server/attribution/settings.ts` + `src/app/api/settings/capi/route.ts`
  + `(owner)/ads/page.tsx`.
- Bandera: patrón `src/server/attribution/flag.ts`.
- `checkRateLimit` (`src/lib/rate-limit.ts`), `timingSafeEqual` como en
  `src/server/bot/auth.ts`.
- `contact.source`, `FichaSource` y `message.type` son `text` en BD (enums solo
  en TypeScript): agregar valores **no** requiere migración.

### Cambios de datos en el CRM (migración `0024`)

- Tabla `intake_settings`: `organization_id` (UNIQUE, FK), `key_cipher`,
  `key_iv`, `key_tag`, `key_last4`, `last_received_at` (jsonb por origen),
  `created_at`, `updated_at`. Aditiva y re-ejecutable.
- `drizzle/0024_leads_externos.sql`, generada sobre `main` con la `0023` de
  022 ya dentro y editada a mano para ser re-ejecutable (IF NOT EXISTS + FK en
  DO-block); solo crea `intake_settings`.

### Servidor (CRM)

- `src/server/intake/flag.ts` — `intakeEnabled()` / `intakeDisabledResponse()`.
- `src/server/intake/settings.ts` — generar (32 bytes, base64url), rotar,
  revocar, vista con `keyLast4`, `verifyIntakeKey(org, key)`.
- `src/server/intake/phone.ts` — normalización RF-4 (pura, unit tests).
- `src/server/intake/ingest.ts` — `ingestExternalLead(orgId, payload)`:
  contacto → conversación → lead → ficha → tarjeta (insert con
  `onConflictDoNothing` sobre `waMessageId`; si no insertó, `duplicate`) →
  `unreadCount+1`, `lastMessageAt` → `publish` ×2. Sin `maybeRunAgentTurn`.
- `src/server/intake/auth.ts` — `requireIntakeKey(req)`: bandera → rate limit →
  organización (`resolveInstanceOrg`) → comparación constante.
- `src/app/api/intake/lead/route.ts` — POST.
- `src/app/api/settings/intake/route.ts` — GET/PUT/DELETE con
  `withAuth(h, { role: "owner" })`.
- Valores nuevos de fuente (D-11-5) en `schema.ts`, `contact-source.ts`
  (`SOURCE_VALUES`/`SOURCE_LABELS`), Zod de `contacts/route.ts` y
  `contacts/[id]/route.ts`, `SourceValue`, `AdSourceKey`,
  `new-contact-dialog.tsx`; `FichaSource` `"externo"` (`ficha-fields.ts`,
  `schema.ts`).
- Excluir `type = 'lead_intake'` en `src/server/reports/agent.ts`: M1/M2
  `attentionSql`, M4 `responseTimesSql` (**en el CTE `msgs`**, para que no
  cuente en el `lag`), M8 `volumeSql`. Aserción nueva en
  `tests/unit/agent-report-sql.test.ts`.
- `src/server/ai/history.ts` `toChatHistory`: la tarjeta se pasa etiquetada.
- `/api/bot/typing`: ignorar `waMessageId like 'intake:%'`.
- Permisos: política nueva `"intake"` en `src/lib/permissions.ts` + guarda en
  `tests/unit/role-matrix.test.ts` (busca `requireIntakeKey(`). Actualizar la
  tabla de `dev-tasks/00-roles-y-permisos.md`.
- `.env.example` (`# LEADS_EXTERNOS=on` con guía) y `lib/env.ts`.

### UI (CRM)

- `src/components/inbox/message-thread.tsx`: caso `lead_intake` → tarjeta
  «🌐 Lead del sitio web» / «🧑‍💼 Lead de promotor (FastApp)» con nombre,
  email, vehículo, sucursal, promotor, presupuesto, notas, código y hora.
- `src/components/inbox/helpers.ts`: `mediaLabel`/`previewText` para la lista
  y la alerta.
- Ajustes: `src/app/(app)/settings/(owner)/leads-externos/page.tsx` +
  `src/components/settings/intake-client.tsx` + pestaña en `settingsTabsFor`
  (solo con la bandera). URL del endpoint, últimos 4, Generar / Rotar /
  Revocar, la clave completa **una sola vez**, último lead por origen y el SQL
  listo para guardar el secreto en Vault.
- Etiquetas de fuente nuevas en ficha, filtros y reporte Anuncios («por
  fuente»).

### Lado ERP (fase aparte — proyecto Supabase «Agencia-ev», requiere OK)

Sin tocar ninguna Edge Function. Una migración en el ERP:

1. Secretos en **Vault**: `crm_intake_url`
   (`https://crm.bers-tech.cloud/api/intake/lead`) y `crm_intake_key`.
2. `public.crm_lead_payload(lead_id uuid) returns jsonb` — arma el contrato
   RF-3 con joins a `branches`, `vehicle_brands`, `vehicle_models`.
3. `public.forward_lead_to_crm()` + trigger `AFTER INSERT ON leads FOR EACH
   ROW WHEN (NEW.source IN ('website','fast_app') AND NEW.phone IS NOT NULL)`
   → `net.http_post(url, body, headers {X-API-Key}, timeout_milliseconds :=
   5000)`. `pg_net` es asíncrono: el INSERT nunca espera ni falla por el CRM.
   `EXCEPTION WHEN OTHERS` → solo `RAISE WARNING` (jamás bloquear el alta).
4. Cron de conciliación `crm-lead-reconcile` (cada hora): reenvía
   los leads de esas fuentes de las **últimas 48 h**. El CRM los descarta por
   idempotencia, así que no hace falta guardar estado; cubre caídas del CRM,
   deploys y rotación de clave. Volumen ~1/día → costo despreciable.
5. Carga inicial opcional (D-11-9): mismo reenvío sobre un rango de fechas.

Por qué no tocar las funciones (opción A original): son dos funciones en vez
de una, la desplegada difiere del repo y la carpeta local está ligada a otro
proyecto; el trigger cubre ambas entradas y cualquier entrada futura con el
mismo `source`, sigue el patrón que el ERP ya usa (`pg_net` + `pg_cron`), y
el cron le da reintento que un `fetch` suelto no tiene.

### Tareas ordenadas

1. Migración `0024` + store de la clave + API de Ajustes (owner) + unit tests.
2. Teléfono + `ingestExternalLead` + endpoint + bandera + rate limit + política
   `"intake"` + unit tests (incluye idempotencia y ambos orígenes).
3. Exclusiones: métricas M1/M4/M8, historial del agente, `/api/bot/typing`.
4. UI: tarjeta en el hilo, vista previa, pestaña de Ajustes, fuentes nuevas.
5. E2E: `tests/e2e/us-leads-externos.md` + `scripts/e2e-leads-externos.mjs`
   (enganchado en `pnpm test:e2e`), con la bandera encendida y apagada.
6. Gate completo + humo en la BD aislada (`.env.e2e`, migración 2×). Deploy
   del CRM con la bandera encendida y clave generada. **Prerequisito para
   encender la bandera:** al menos una plantilla **aprobada** por Meta para
   el primer contacto de seguimiento (variables: nombre, vehículo); sin ella
   el lead llega y nadie puede contestarle (ventana cerrada).
7. ERP (con OK): migración del trigger + cron + Vault. Prueba real: un envío
   del formulario de producción y uno de FastApp aparecen en la Bandeja; luego
   carga inicial si se aprueba.

### Pruebas

- Unit: teléfono (10, `52`, `521`, `+52`, espacios/guiones, inválidos),
  comparación de clave, Zod del contrato (ambos orígenes), SQL de métricas con
  la exclusión, `toChatHistory` con la tarjeta, matriz de rutas.
- E2E (ON): 401 clave mala · 201 alta `website` y `fast_app` · mismo
  `lead_id` 2× = 1 tarjeta · mismo teléfono por ambos orígenes = 1
  conversación, 2 tarjetas · conversación sin asignar visible para un
  Vendedor · compositor en modo plantilla · el agente no corre (ai-mock sin
  llamadas) · mensaje de wa-mock desde `52…` cae en la misma conversación y
  abre la ventana · Vendedor 403 en `/api/settings/intake` · 429.
- E2E (OFF): endpoint y pestaña en 404.
- ERP: probar el trigger y el payload primero en una **rama** de Supabase (o
  con el endpoint apuntando a un receptor de prueba) antes de producción.

### Riesgos y decisiones abiertas

| # | Decisión | Recomendación |
|---|---|---|
| D-11-1 | Cómo reenvía el ERP | **Trigger + `pg_net` + cron de conciliación** en la BD (cubre web y FastApp, no toca funciones, reintenta solo). |
| D-11-2 | Dónde van email / vehículo / sucursal / promotor | Tarjeta siempre; además en la ficha si el negocio tiene esos campos. Sin columna `email` nueva en `contact`. |
| D-11-3 | Si el CRM falla | Lo cubre el cron de conciliación (48 h) gracias a la idempotencia. |
| D-11-4 | ¿Detrás de bandera? | Sí, `LEADS_EXTERNOS`, apagada por defecto (ADR-001). |
| D-11-5 | Fuente del contacto | Dos valores nuevos: «Sitio web» (`web`) y «Promotor» (`promotor`). Solo si el contacto no tenía fuente. Aparecen en el reporte «por fuente». |
| D-11-6 | Vendedor asignado | Entra **sin asignar** en el CRM aunque el ERP le asigne vendedor; no se sincroniza. |
| D-11-7 | ¿Contestar automáticamente? | No en v1; fase 2: plantilla de bienvenida automática configurable. |
| D-11-8 | ¿También `walk_in` / `social_media`? | No en v1 (se capturan a mano y casi nunca traen intención de WhatsApp); ampliar el `WHEN` del trigger cuando se quiera. |
| D-11-9 | ¿Cargar los leads históricos? | Solo los de los **últimos 30 días** (~17), para que los vendedores puedan darles seguimiento; los anteriores no. |

Riesgos:

- **Dos repos y dos BD**: el cambio del ERP va en su propio repo
  (`agenciaev`, migración nueva en `supabase/migrations/`) y se aplica al
  proyecto real `vqfctefthnqjwryhkbna`, no al que tiene ligado la carpeta.
- **Numeración**: resuelta — `0023` es de 022, `0024` de esta tarea.
- **Suposición «10 dígitos = México»**: válida para este ERP; otro negocio
  debe mandar lada.
- **Clave**: vive solo en Vault del ERP y cifrada en el CRM; nunca en un
  navegador ni en el código.
- **FastApp no limpia el teléfono**: lo resuelve RF-4 del lado CRM.

### Notas de implementación (lado CRM, 2026-10-19)

Lo que quedó distinto o más preciso que el plan, y por qué:

- **Orden en `ingestExternalLead`**: contacto → conversación → **tarjeta**
  (insert con `onConflictDoNothing` sobre `intake:<lead_id>`) → fuente → lead
  → ficha → contadores → `publish`. La tarjeta va antes que fuente/lead/ficha
  para que un `lead_id` repetido corte sin efectos (RF-11). Los pasos
  posteriores a la tarjeta se registran y siguen si fallan (el lead ya está
  en la Bandeja y un reintento sería duplicado).
- **Campos estructurados de la tarjeta sin columna nueva**: `message.text` es
  el resumen legible con la cabecera de origen en la primera línea y un campo
  por línea (`src/lib/lead-intake.ts`). Lo leen igual el hilo (tarjeta), la
  lista/alerta (vista previa) y el historial del agente. Así la migración se
  queda en `intake_settings`.
- **`lastMessageAt = greatest(actual, ahora)`**: un lead viejo (carga inicial
  D-11-9, conciliación de 48 h) no entierra una conversación más reciente; la
  hora real del lead va en el `waTimestamp` de la tarjeta.
- **Historial del agente**: además de etiquetar la tarjeta, se excluye de
  `lastInboundText` para que el respaldo de handoff no corra sobre las notas
  del prospecto.
- **Errores**: siguen la convención del repo `{ error: { code, message } }`
  (RF-12 decía `{ error: code }`). El duplicado responde 200
  `{ duplicate: true, contactId, conversationId }`.
- **Ficha (RF-9)**: el correo va a la clave que el negocio tenga para él
  (`email`/`correo`) o a `email` como clave libre (contrato de `bot`);
  vehículo → `vehiculo`/`modelo_interes`/`modelo` y sucursal → `sucursal`
  solo si el negocio definió ese campo de texto. `FichaSource` `"externo"`
  sigue la regla de `bot` (respeta el candado humano) y tiene su chip «Web».
- **Fuentes nuevas** en orden: … «Conocido», «Sitio web», «Promotor», «Otro».
- **«El agente no corre»** se prueba por lo observable (sin salientes y
  `handoffAt` null con el agente encendido) en vez de contar llamadas al
  ai-mock, que no las cuenta.
- E2E: `tests/e2e/us-leads-externos.md` + `scripts/e2e-leads-externos.mjs`
  (completo) y sección `011` en `scripts/e2e-selftest.mjs` (`pnpm test:e2e`).
- La tarjeta y el `update` de la Bandeja (no leídos, `lastMessageAt`,
  desarchivo) van en **una transacción**: si el update falla, la tarjeta se
  revierte y el endpoint da 500, así el reintento del ERP vuelve a entrar en
  vez de caer en `duplicate` con la conversación sin subir ni avisar. Fuente,
  lead, ficha y «último recibido» van en `step()` (accesorios; al log solo
  `err.message`); los `publish`, tras el commit.

### Choques con 022 (resueltos al rebasar, 2026-10-19)

- **Nombre**: `contact.profile_name` es el nombre de perfil del CANAL (nick de
  WhatsApp) y el formulario no lo es. `ingestExternalLead` llama a
  `getOrCreateContactByIdentity` con `profileName: null` y pone el nombre
  completo del lead en `name` solo si el actual es de respaldo
  (`isFallbackName`: contacto nuevo → su teléfono), antes de la tarjeta. Si se
  pasara como `profileName`, un lead de FastApp pisaría el nick real y la
  línea «WhatsApp: «…»» mentiría tras renombrar. Cuando el prospecto escribe
  por WhatsApp, su nick va a `profile_name` y el nombre del lead se queda.
- **Archivo**: la tarjeta es un entrante → el `update` de la Bandeja mezcla
  `UNARCHIVE_SET` (como el entrante de WhatsApp). Va tras el dedupe de la
  tarjeta: un `lead_id` repetido no desarchiva. `conversation.updated` ya se
  publicaba.
- E2E: `profileName` null en e) y g), el nick en m), y la sección g2)
  (archivar → lead nuevo desarchiva → duplicado no).

### Antes del merge

Hecho: rebase sobre `main` (021 + 022), migración `0024_leads_externos`,
choques con 022 y re-verificación en la BD aislada (`vocero011`, migraciones
2×, más la `0024` aplicada 2× a mano): gate verde; `e2e-leads-externos`
103/103 (ON) y 8/8 (OFF); `e2e-selftest` 488/488 (ON) y 482/482 (OFF);
`e2e-archivo` 66/66 y `e2e-archivo-ui` 46/46. Falta solo el merge y, con el
deploy, aplicar la bandera `LEADS_EXTERNOS` donde se use.

### Fase ERP — ajustes de diseño acordados antes de pedir OK

- El `WHEN` del trigger y el cron exigen teléfono con 10, 12 o 13 dígitos
  tras quitar no-dígitos (FastApp no limpia el formato); si no, un lead
  inválido devolvería 422 en cada vuelta durante 48 h.
- Cron de conciliación **horario** (no cada 15 min): a ~1 lead/día basta, y
  evita ~190 «duplicado, sin efectos» por lead en el log del CRM.
- La carga inicial (D-11-9, ~17 leads) hace aparecer ~17 conversaciones y
  alertas de golpe: avisar a los vendedores o hacerla a una hora acordada.

## 3. Dependencias con otras tareas

- **00**: guarda de Propietario y matriz de permisos.
- **04**: `upsertFicha` y regla de no pisar ediciones humanas.
- **05**: la alerta sale sola del `message.new` entrante.
- **09**: conversación nueva sin asignar, visible para todos los vendedores.
- **02**: exclusión del tipo `lead_intake` en las métricas.
- **020**: fuente del contacto y reporte «por fuente».
- **022** (ya en `main`): migración `0023`, `contact.profile_name` y archivo
  de conversaciones (ver «Choques con 022» arriba).
