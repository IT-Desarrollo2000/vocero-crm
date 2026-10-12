# 00 — Roles y permisos (Propietario / Vendedor)

> Estado: propuesto · Prioridad: crítica (fundacional + cierra huecos de seguridad) · Esfuerzo: M · Migración: sí, mínima (`0013`, solo un índice único en `member`; el rol se queda como `member` en BD, sin reescribir valores) · Bandera: no (es núcleo, no módulo opcional)

## 1. Especificación

### Problema / objetivo

Hoy Vocero tiene dos roles en BD (`owner` y `member`) pero casi ninguna regla
los distingue: solo 4 handlers comparan `session.role !== "owner"`. Cualquier
cuenta de equipo puede cambiar o desconectar las credenciales de
WhatsApp/Instagram/Messenger/CAPI/Google/Zoom, leer el verify token del
webhook, reescribir el prompt y la base de conocimiento del agente, correr o
borrar evaluaciones del Laboratorio, borrar etapas del pipeline y —vía el
plugin `organization` de Better Auth expuesto en `/api/auth/*`— crear otra
organización, cambiar roles o borrar la organización.

Objetivo: dejar **exactamente dos roles** con una matriz de permisos explícita,
aplicada **en el servidor** (API y páginas) y reflejada en la UI (menú y
Ajustes), más la gestión mínima de equipo que el Propietario necesita (cambiar
rol, dar de baja, restablecer contraseña) sin dejar nunca la organización sin
Propietario.

**Decisión de modelo (cerrada aquí): se conserva `member` en BD y se etiqueta
"Vendedor" en la UI.** Motivos:

1. Compatibilidad: todas las filas existentes, el default de la columna
   (`src/lib/db/schema.ts:86`) y el alta de equipo
   (`src/app/api/settings/team/route.ts:78`) ya usan `member`; migrar a
   `seller` obliga a reescribir datos en producción sin ganar nada.
2. `member` es el rol "mínimo" nativo del plugin `organization` de Better Auth;
   conservarlo evita que el plugin interprete un valor desconocido.
3. La traducción vive en un solo lugar (`src/lib/roles.ts`, nuevo): el código
   habla de `isOwner()` / `ROLE.seller`, nunca del literal.

Cualquier valor distinto de `owner` (p. ej. un `admin` inyectado por el
endpoint del plugin) se **normaliza a Vendedor** al resolver la sesión: nunca
otorga más permisos.

### Alcance (incluye) / Fuera de alcance

**Incluye**
- Tipo `Role = "owner" | "member"`, etiquetas UI ("Propietario" / "Vendedor") y
  normalización en `requireSession()`.
- `withAuth(handler, { role: "owner" })` en `src/lib/api.ts` → 403 `forbidden`.
- Matriz completa endpoint → rol para todo `src/app/api/**/route.ts`, aplicada
  y vigilada por un test que recorre el árbol de rutas.
- Guardas en páginas server (`notFound()`) para Agente, Laboratorio, Ajustes
  de negocio y la futura pantalla de Reportes.
- Menú lateral y pestañas de Ajustes filtradas por rol; enlaces a pantallas de
  Propietario ocultos o reescritos en componentes compartidos.
- Pantalla nueva **"Mi cuenta"** (`/settings/account`): nombre, tema y cambio de
  contraseña propia. Es la única pestaña de Ajustes del Vendedor.
- Cierre de huecos: endpoints del plugin `organization`, verify token del
  webhook, credenciales, prompt/KB, Laboratorio, etapas, seed demo.
- Gestión de equipo (solo Propietario): cambiar rol, dar de baja (revoca
  sesiones), restablecer contraseña temporal, re-alta de una cuenta dada de
  baja; invariante "siempre ≥ 1 Propietario".
- `resolveMembership` determinista.
- Bloqueo de inicio de sesión para cuentas sin membresía (dadas de baja).

**Fuera de alcance**
- Visibilidad de conversaciones por vendedor (asignación) → tarea **09**.
- Pantalla de Reportes y métricas → tarea **02** (aquí solo se reserva su regla:
  Propietario).
- Roles personalizados, permisos granulares por usuario, invitaciones por
  correo (prohibido por soberanía: sin email), 2FA, SSO.
- Borrado físico de la fila `user` (ver decisiones abiertas).

### Historias de usuario

- Como **Propietario** quiero que mis vendedores no puedan tocar credenciales,
  plantillas, el agente ni la configuración, para que un error o una mala
  intención no tumbe mi canal de WhatsApp.
- Como **Propietario** quiero dar de baja a un vendedor que se fue y que su
  sesión muera en ese momento, para que no siga leyendo mis conversaciones.
- Como **Propietario** quiero restablecer la contraseña de un vendedor que la
  olvidó, sin depender de un correo ni del servidor, para que vuelva a trabajar
  en minutos.
- Como **Propietario** quiero poder nombrar a otro Propietario (socio, agencia)
  sin riesgo de que la organización quede sin dueño.
- Como **Vendedor** quiero ver solo lo que uso a diario (Bandeja, Pipeline,
  Contactos, Citas) y mi cuenta, para no perderme en pantallas que no me tocan.
- Como **Vendedor** quiero cambiar mi propia contraseña temporal, para que nadie
  más la conozca.

### Requisitos funcionales

- **RF-00-01** Existen exactamente dos roles efectivos: Propietario (`owner`) y
  Vendedor (`member`). `requireSession()` devuelve `role: Role`; cualquier
  valor en BD distinto de `owner` se trata como `member`.
- **RF-00-02** `withAuth` acepta `{ role: "owner" }`; si la sesión no es
  Propietario responde `403 { error: { code: "forbidden" } }` **sin ejecutar** el
  handler (ni parsear el body).
- **RF-00-03** Toda ruta de `src/app/api/**/route.ts` y todo método exportado
  está clasificado en la matriz de §1 "Permisos por rol"; un test falla si
  aparece un handler nuevo sin clasificar o si una ruta marcada Propietario no
  usa la guarda.
- **RF-00-04** Las páginas Agente (`/agent`), Laboratorio (`/lab`), Reportes
  (futura) y todas las de Ajustes salvo `/settings/account` responden 404 al
  Vendedor (renderizado server-side, sin flash de contenido).
- **RF-00-05** El menú lateral del Vendedor muestra: Bandeja, Pipeline, Citas
  (si `AGENDA`), Contactos, y el engrane de Ajustes que lleva a "Mi cuenta". No
  muestra Agente ni Laboratorio (ni Reportes).
- **RF-00-06** La navegación de Ajustes del Vendedor solo contiene "Mi cuenta";
  `/settings` redirige a `/settings/account` (Vendedor) o `/settings/whatsapp`
  (Propietario).
- **RF-00-07** En el Pipeline, el Vendedor no ve "Gestionar etapas"; sí mueve
  tarjetas, captura monto, prioridad y motivo de pérdida.
- **RF-00-08** El Vendedor puede **enviar** plantillas aprobadas desde la Bandeja
  y Contactos (lee `GET /api/templates`), pero no crearlas ni sincronizarlas.
  Los enlaces "crear plantilla" se sustituyen por "Pide al propietario que
  cree una plantilla".
- **RF-00-09** En el panel del contacto el Vendedor sigue viendo y usando el
  interruptor de IA de la conversación; `GET /api/agent/profile` le devuelve
  solo `{ profile: { enabled }, aiConfigured }` (nunca `instructions`,
  `escalationRules`, `tone`, `greeting`). El enlace "Configurar agente" no se
  muestra.
- **RF-00-10** Todos los endpoints `/api/auth/organization/*` del plugin
  responden 404; `allowUserToCreateOrganization: false` y
  `disableOrganizationDeletion: true` como defensa en profundidad.
- **RF-00-11** Gestión de equipo (solo Propietario), desde Ajustes → Equipo:
  - cambiar rol de un miembro (Propietario ↔ Vendedor);
  - dar de baja: borra la membresía y **todas** las sesiones del usuario;
  - restablecer contraseña: genera una temporal (mostrada una sola vez), la
    guarda hasheada y revoca sus sesiones;
  - re-alta: dar de alta un correo que ya existe como usuario sin membresía lo
    re-vincula (con nueva contraseña temporal) en vez de responder 409.
- **RF-00-12** Invariante: la organización tiene siempre ≥ 1 Propietario. Un
  Propietario no puede darse de baja a sí mismo ni cambiar su propio rol desde
  la API (409 `self_change`), y ninguna operación puede dejar 0 Propietarios
  (409 `last_owner`), incluso con dos peticiones concurrentes.
- **RF-00-13** Una cuenta sin membresía no puede iniciar sesión (403 "Tu cuenta
  fue dada de baja"); una sesión viva de una cuenta dada de baja recibe 401 en
  la siguiente petición.
- **RF-00-14** `resolveMembership` es determinista (`ORDER BY created_at, id`);
  `member(organization_id, user_id)` es único.
- **RF-00-15** Los cambios de rol surten efecto en la siguiente petición (la
  membresía se lee de BD en cada `requireSession`, sin caché).
- **RF-00-16** "Mi cuenta": cualquier rol cambia su nombre (Better Auth
  `/update-user`) y su contraseña (Better Auth `/change-password` con
  `revokeOtherSessions: true`, pide la actual). El tema sigue en el lateral.

### Permisos por rol

Leyenda: ✅ ver y editar · 👁 solo ver · ❌ no ve (UI oculta + API 403 / página 404).

| Área | Propietario | Vendedor |
|---|---|---|
| Bandeja: leer, responder, adjuntos, ubicación/contacto | ✅ | ✅ (visibilidad por asignación en 09) |
| Bandeja: enviar plantilla aprobada | ✅ | ✅ |
| Bandeja: interruptor IA / reactivar tras handoff, marcar leído | ✅ | ✅ |
| Contactos: listar, crear, editar notas/ficha, archivar, iniciar conversación | ✅ | ✅ (alcance final en 09) |
| Pipeline: ver tablero, mover leads, monto, prioridad, motivo de pérdida | ✅ | ✅ |
| Pipeline: crear/renombrar/reordenar/borrar etapas | ✅ | ❌ |
| Citas (si `AGENDA`): ver, crear, cambiar estado | ✅ | ✅ |
| Agente (prompt, KB, perfil) | ✅ | ❌ (solo `enabled` en lectura reducida) |
| Laboratorio | ✅ | ❌ |
| Reportes y métricas (tarea 02) | ✅ | ❌ |
| Ajustes: WhatsApp, Instagram, Messenger, webhook | ✅ | ❌ |
| Ajustes: Plantillas (crear, sincronizar) | ✅ | ❌ (enviar sí, ver arriba) |
| Ajustes: Agenda (horarios, Google, Zoom) | ✅ | ❌ |
| Ajustes: Equipo | ✅ | ❌ |
| Ajustes: Marca / favicon | ✅ | ❌ (la marca se sigue VIENDO aplicada) |
| Ajustes: Anuncios / CAPI (si `ATRIBUCION`) | ✅ | ❌ |
| Mi cuenta: nombre, contraseña propia, tema | ✅ | ✅ |
| Datos de demostración (`seed/demo`) | ✅ | ❌ |

**Gestionar plantillas = ajuste** (decidido): crearlas cuesta dinero/reputación
ante Meta y son parte del canal; enviarlas es operación diaria.

#### Matriz de endpoints (fuente de verdad de RF-00-03)

Política: `owner` = `withAuth(..., { role: "owner" })` · `any` = `withAuth`
sin rol (Propietario y Vendedor) · `any*` = cualquier rol con respuesta
filtrada por rol · `public` = sin sesión, con su propia defensa · `bot` =
`BOT_API_KEY` (`src/server/bot/auth.ts`) · `dev` = `mockGuard()` (404 en
producción).

| Ruta (bajo `src/app/api/`) | Método | Política | Nota |
|---|---|---|---|
| `conversations/route.ts` | GET | any* | 09 filtra por asignación |
| `conversations/[id]/route.ts` | PATCH | any* | 09: asignación |
| `conversations/[id]/messages/route.ts` | GET, POST | any* | 09 |
| `conversations/[id]/messages/media/route.ts` | POST | any* | 09 |
| `conversations/[id]/messages/template/route.ts` | POST | any* | 09 |
| `media/[assetId]/route.ts` | GET | any* | 09 |
| `events/route.ts` | GET | any* | sesión propia (no `withAuth`); 09 filtra eventos; `lab.run` solo Propietario (aquí) |
| `contacts/route.ts` | GET, POST | any | |
| `contacts/[id]/route.ts` | GET, PATCH | any | |
| `contacts/[id]/start-conversation/route.ts` | POST | any* | 09 |
| `pipeline/board/route.ts` | GET | any | |
| `pipeline/leads/[id]/route.ts` | PATCH | any | mover/monto/prioridad |
| `pipeline/stages/route.ts` | GET | any | lo usan `use-stages.ts`, `contact-panel.tsx`, `new-contact-dialog.tsx` |
| `pipeline/stages/route.ts` | POST | **owner** | hoy abierto |
| `pipeline/stages/[id]/route.ts` | PATCH, DELETE | **owner** | hoy abierto |
| `bookings/route.ts` | GET, POST | any | |
| `bookings/[id]/route.ts` | PATCH | any | |
| `calendar/availability/route.ts` | GET | any | lo usa `bookings-client.tsx:59` |
| `calendar/settings/route.ts` | GET, PUT | **owner** | |
| `templates/route.ts` | GET | any | composer/template-sender/start-conversation |
| `templates/route.ts` | POST | **owner** | hoy abierto |
| `templates/sync/route.ts` | POST | **owner** | hoy abierto |
| `agent/profile/route.ts` | GET | any* | Vendedor: solo `enabled` + `aiConfigured` |
| `agent/profile/route.ts` | PUT | **owner** | hoy abierto |
| `kb/route.ts` | GET, POST | **owner** | hoy abierto |
| `kb/[id]/route.ts` | PATCH, DELETE | **owner** | hoy abierto |
| `kb/size/route.ts` | GET | **owner** | |
| `lab/runs/route.ts` | GET, POST | **owner** | hoy abierto |
| `lab/runs/[id]/route.ts` | GET, DELETE | **owner** | hoy abierto |
| `lab/suggestions/apply/route.ts` | POST | **owner** | hoy abierto (reescribe el prompt) |
| `seed/demo/route.ts` | POST | **owner** | botón en `conversation-list.tsx:27` |
| `settings/whatsapp/route.ts` | GET, PUT | **owner** | hoy abierto |
| `settings/whatsapp/test/route.ts` | POST | **owner** | hoy ignora `_session` |
| `settings/webhook/route.ts` | GET | **owner** | hoy entrega `verifyToken` a cualquiera |
| `settings/instagram/route.ts` | GET, PUT, DELETE | **owner** | |
| `settings/messenger/route.ts` | GET, PUT, DELETE | **owner** | |
| `settings/capi/route.ts` | GET, PUT, DELETE | **owner** | |
| `settings/capi/events/route.ts` | GET | **owner** | |
| `settings/capi/events/retry/route.ts` | POST | **owner** | |
| `settings/capi/events/[id]/retry/route.ts` | POST | **owner** | |
| `settings/google/route.ts` | GET, PUT, DELETE | **owner** | |
| `settings/google/test/route.ts` | POST | **owner** | |
| `settings/zoom/route.ts` | GET, PUT, DELETE | **owner** | |
| `settings/zoom/test/route.ts` | POST | **owner** | |
| `settings/team/route.ts` | GET, POST | **owner** | GET hoy abierto (lista correos) |
| `settings/team/[memberId]/route.ts` (nuevo) | PATCH, DELETE | **owner** | cambiar rol / baja |
| `settings/team/[memberId]/reset-password/route.ts` (nuevo) | POST | **owner** | |
| `settings/branding/route.ts` | GET | public | sin `withAuth` hoy (línea 11): la marca la pinta también `/login` |
| `settings/branding/route.ts` | PUT | **owner** | ya chequea a mano (línea 25) → migrar a la guarda |
| `settings/branding/favicon/route.ts` | PUT, DELETE | **owner** | ya chequea a mano (19, 65) → migrar |
| `branding/favicon/route.ts` | GET | public | icono de pestaña |
| `auth/[...all]/route.ts` | GET, POST | public | Better Auth; `/organization/*` bloqueado (RF-00-10) |
| `health/route.ts` | GET | public | |
| `meta/data-deletion/route.ts` | POST | public | firmado por Meta |
| `webhooks/{wa,ig,fb}/[webhookToken]/route.ts` | GET, POST | public | segmento secreto + firma |
| `bot/*` (10 rutas) | * | bot | sin sesión; no cambia |
| `dev/*` (14 rutas) | * | dev | `src/lib/dev-guard.ts` |
| `reports/*`, `metrics/*` (futuras, tarea 02) | * | **owner** | regla reservada |

### Criterios de aceptación

1. **Dado** un Vendedor con sesión, **cuando** hace `PUT /api/settings/whatsapp`,
   `GET /api/settings/webhook`, `PUT /api/agent/profile`, `POST /api/kb`,
   `POST /api/lab/runs`, `DELETE /api/pipeline/stages/:id`, `POST /api/templates`
   o `POST /api/seed/demo`, **entonces** recibe 403 `forbidden` y nada cambia en
   BD (verificado releyendo como Propietario).
2. **Dado** un Vendedor, **cuando** abre `/agent`, `/lab`, `/settings/whatsapp`,
   `/settings/team` o `/settings/templates`, **entonces** ve la página 404 de la
   app, y **cuando** abre `/settings`, **entonces** termina en
   `/settings/account`.
3. **Dado** un Vendedor en la Bandeja, **cuando** carga la página, **entonces**
   el lateral no tiene "Agente" ni "Laboratorio" y el panel del contacto sigue
   mostrando el interruptor de IA con su estado correcto.
4. **Dado** un Vendedor, **cuando** hace `GET /api/agent/profile`, **entonces**
   la respuesta no contiene `instructions` ni `escalationRules`.
5. **Dado** cualquier usuario autenticado, **cuando** hace
   `POST /api/auth/organization/create` o `.../update-member-role`, **entonces**
   recibe 404 y no aparece una segunda organización ni cambia ningún rol.
6. **Dado** un Propietario único, **cuando** intenta cambiar su propio rol o
   darse de baja, **entonces** recibe 409 (`self_change`), y **dado** dos
   Propietarios que se degradan mutuamente a la vez, **entonces** exactamente una
   petición tiene éxito y la otra recibe 409 `last_owner`.
7. **Dado** un Vendedor con sesión abierta, **cuando** el Propietario lo da de
   baja, **entonces** su siguiente petición responde 401, la Bandeja lo manda a
   `/login` y un nuevo login responde 403 "dada de baja".
8. **Dado** un Vendedor que olvidó su contraseña, **cuando** el Propietario la
   restablece, **entonces** la contraseña vieja deja de servir, la temporal
   funciona y sus sesiones anteriores quedan revocadas.
9. **Dado** un Vendedor, **cuando** cambia su contraseña en "Mi cuenta" con la
   actual correcta, **entonces** puede entrar con la nueva y no con la vieja; con
   la actual incorrecta ve un error y nada cambia.
10. **Dado** el repo, **cuando** alguien agrega `src/app/api/x/route.ts` sin
    clasificarlo, **entonces** `pnpm test` falla nombrando la ruta.

### Casos borde y degradación

- **Rol desconocido en BD** (`admin`, vacío, mayúsculas): se trata como
  Vendedor (nunca escala). Se registra un `console.warn` una vez por proceso.
- **Membresía duplicada** (hoy posible: no hay índice único y
  `team/route.ts:80` usa `onConflictDoNothing` sin conflicto que detectar): la
  migración deduplica conservando la más antigua (prefiriendo `owner`).
- **Vendedor con la pantalla abierta cuando lo degradan/dan de baja**: los fetch
  responden 401/403; el cliente no se cuelga — las pantallas ya toleran `!res.ok`
  (p. ej. `inbox-client.tsx:76-78`); y, tras el cambio propuesto en `app-shell.tsx` (§UI), se redirige a `/login` ante 401.
- **SSE abierto de un usuario dado de baja**: la conexión `/api/events` sigue
  viva hasta que se cae; al reconectar recibe 401. Se acepta (≤ heartbeat de
  25 s de exposición a ids, no a contenido, una vez aplicada 09). Mejora
  opcional: registrar conexiones por `userId` y cerrarlas en la baja.
- **Alta de equipo** (`team/route.ts:52`): `signUpEmail` crea sesión antes de
  que exista la membresía; el bloqueo de RF-00-13 debe **saltarse dentro de
  `runInternalSignup`** o romperá el alta.
- **Primer registro de la instancia**: `onUserCreated` crea la membresía
  `owner` en `user.create.after`, antes de que se cree la sesión: el bloqueo no
  lo afecta. Cubrirlo con test.
- **Propietario que cambia su contraseña**: `revokeOtherSessions` cierra sus
  otras pestañas/dispositivos; la actual sigue.
- **Restablecer contraseña de otro Propietario**: permitido (son pares), pero no
  la propia por esta vía (usa "Mi cuenta").
- **Enlaces viejos guardados** (`/agent` en marcadores de un vendedor): 404
  limpio, no error 500.

## 2. Plan técnico

### Estado actual

- Rol en BD: `member.role` texto libre, default `"member"` —
  `src/lib/db/schema.ts:78-88` (sin índice único `(organization_id, user_id)`).
- Plugin: `organization({ creatorRole: "owner" })` sin AC ni opciones —
  `src/lib/auth/index.ts:65`. Su handler completo queda expuesto por
  `src/app/api/auth/[...all]/route.ts:1-11`. Better Auth instalado: 1.6.23
  (`package.json:28` pide `^1.1.14`), que expone `/organization/create`,
  `/update-member-role`, `/delete`, `/leave`, `/remove-member`,
  `/invite-member`, `/set-active`, etc. El cliente
  (`src/lib/auth/client.ts:7`) registra `organizationClient()` pero **ningún**
  componente llama `authClient.organization.*`.
- Hook `before` ya existente (rate limit + registro cerrado):
  `src/lib/auth/index.ts:67-90` — es el lugar natural para el bloqueo de
  `/organization/*`.
- Owner al primer registro: `src/server/auth/on-signup.ts:39-44`.
  `resolveMembership` hace `LIMIT 1` sin `ORDER BY`: `on-signup.ts:68-81`.
- Sesión: `requireSession()` → `{ userId, organizationId, role: string }` —
  `src/lib/auth/session.ts:22-37`.
- `withAuth` sin parámetro de rol: `src/lib/api.ts:17-37`.
- Únicos chequeos de rol: `settings/team/route.ts:43`,
  `settings/branding/route.ts:25`, `settings/branding/favicon/route.ts:19` y
  `:65`.
- Equipo: alta con contraseña temporal `settings/team/route.ts:42-83`; GET sin
  guarda (`:11-33`) devuelve nombre+correo de todos. UI
  `src/components/settings/team-client.tsx` (badge "Propietario"/"Miembro" en
  `:156-157`). No hay baja, cambio de rol ni restablecer contraseña; el único
  reset es `scripts/reset-password.mjs` (imprime un `UPDATE` con
  `hashPassword` de `better-auth/crypto`).
- Rol al cliente: `src/app/(app)/layout.tsx:32` → `AppShell`
  (`src/components/app-shell.tsx:26,78`) → `AppNav`
  (`src/components/app-nav.tsx:53`; solo pinta "Propietario"/"Equipo" en
  `:274`). El menú `NAV` (`app-nav.tsx:35-41`) y el engrane de Ajustes
  (`app-nav.tsx:237`) no filtran por rol.
- Ajustes: `src/app/(app)/settings/layout.tsx` (síncrono, sin rol) +
  `src/components/settings/settings-nav.tsx:9-14`; `settings/page.tsx:3-5`
  redirige siempre a WhatsApp. Las páginas de Ajustes son wrappers de un client
  component (`settings/team/page.tsx`, `templates/page.tsx`,
  `whatsapp/page.tsx`); las de módulos usan `notFound()` por bandera
  (`settings/calendar/page.tsx:9`) — mismo patrón a reutilizar.
- Componentes compartidos que enlazan a pantallas de Propietario:
  `contact-panel.tsx:254` (`/agent`), `template-sender.tsx:54` y
  `contacts/start-conversation.tsx:88` (`/settings/templates`),
  `pipeline-client.tsx:178` ("Gestionar etapas") y `:213` (`StageManager`),
  `conversation-list.tsx:27` (seed demo).
- `contact-panel.tsx:57-59,77-78` lee `GET /api/agent/profile` solo para
  `enabled`/`aiConfigured`.
- SSE: `src/app/api/events/route.ts:14-46` publica a toda la org, incluido
  `lab.run` (`src/server/events/bus.ts:24-31`).
- No existe pantalla de perfil/contraseña propia.

### Cambios de datos

Migración `drizzle/0013_roles_miembros.sql` (número = siguiente libre al
implementar), editada a mano para ser **re-ejecutable** como
`drizzle/0012_handoff_nota.sql`:

```sql
-- 1) Deduplicar membresías (conserva la más antigua, prefiriendo owner).
DELETE FROM "member" m USING "member" d
 WHERE m.organization_id = d.organization_id AND m.user_id = d.user_id
   AND (CASE WHEN m.role='owner' THEN 0 ELSE 1 END, m.created_at, m.id)
     > (CASE WHEN d.role='owner' THEN 0 ELSE 1 END, d.created_at, d.id);
-- 2) Unicidad que el alta de equipo ya asumía (onConflictDoNothing).
CREATE UNIQUE INDEX IF NOT EXISTS "member_org_user_uq"
  ON "member" ("organization_id", "user_id");
```

- **No** se reescriben valores de `role` (se conserva `member`); la
  normalización de valores raros vive en código (RF-00-01). Sin CHECK para no
  romper filas existentes con valores raros.
- `member` no es tabla de dominio (es de Better Auth) pero ya tiene
  `organization_id NOT NULL`; toda query nueva sobre `member` usa
  `scoped(schema.member.organizationId, ...)` como hace `team/route.ts:23`.
- `schema.ts`: agregar `uniqueIndex("member_org_user_uq")` a `member`
  (`:78-88`) y correr `pnpm db:generate`; sustituir el SQL generado por el de
  arriba.

### Servidor

1. **`src/lib/roles.ts` (nuevo)** — `export type Role = "owner" | "member"`,
   `ROLE = { owner: "owner", seller: "member" } as const`,
   `normalizeRole(raw: string): Role`, `isOwner(s: { role: Role })`,
   `roleLabel(r: Role): "Propietario" | "Vendedor"`. Importable desde cliente
   (sin dependencias de servidor).
2. **`src/lib/auth/session.ts`** — `SessionContext.role: Role`; en
   `requireSession()` (`:29-36`) devolver `normalizeRole(membership.role)`.
3. **`src/lib/api.ts`** — firma
   `withAuth(handler, opts?: { role?: Role })`; tras resolver sesión
   (`:22-29`), si `opts?.role === "owner" && session.role !== "owner"` →
   `apiError(403, "forbidden", "Solo el propietario puede hacer esto")`.
   Exportar también `requireOwner(session): Response | null` para los handlers
   con política `any*` que bifurcan.
4. **Aplicar la matriz**: envolver cada handler `owner` con
   `withAuth(fn, { role: "owner" })`; quitar los 4 chequeos manuales
   (`team/route.ts:43`, `branding/route.ts:25`, `branding/favicon/route.ts:19,65`)
   en favor de la guarda.
5. **`src/app/api/agent/profile/route.ts:9-29`** — si no es owner, responder
   `{ profile: { enabled: p.enabled }, aiConfigured }`.
6. **`src/app/api/events/route.ts`** — no reenviar `lab.run` a no-owners
   (filtro en el `subscribe` de `:40-46`). El resto del filtrado lo hace 09.
7. **`src/lib/auth/index.ts`**
   - `organization({ creatorRole: "owner", allowUserToCreateOrganization: false, disableOrganizationDeletion: true })`.
   - En `hooks.before` (`:67`): `if (ctx.path.startsWith("/organization/")) throw new APIError("NOT_FOUND")`.
   - En `databaseHooks.session.create.before` (`:101-110`): si
     `resolveActiveOrganizationId` es `null`, existe al menos una organización
     y **no** es `isInternalSignup()` → `throw new APIError("FORBIDDEN", { message: "Tu cuenta fue dada de baja" })`.
   - Quitar `organizationClient()` de `src/lib/auth/client.ts:7` (no se usa).
8. **`src/server/auth/on-signup.ts:68-81`** — `resolveMembership`:
   `.orderBy(asc(schema.member.createdAt), asc(schema.member.id))`.
9. **`src/server/team/members.ts` (nuevo)** — lógica de equipo, toda en
   transacción y con `scoped()`:
   - `listMembers(orgId)` (sale de `team/route.ts:11-33`); devuelve también `userId` (lo necesita el selector de responsable de 09).
   - `changeRole(orgId, actorUserId, memberId, role)`: 409 `self_change` si el
     miembro es el actor; dentro de la transacción
     `SELECT ... FROM member WHERE organization_id=$1 AND role='owner' FOR UPDATE`
     y 409 `last_owner` si la operación dejaría 0.
   - `removeMember(orgId, actorUserId, memberId)`: mismas guardas; borra la fila
     `member`, borra `session` por `user_id` (no hay `cookieCache`
     configurado, así que borrar en BD invalida de inmediato) y llama el hook
     `onMemberRemoved(orgId, userId, tx)` — **punto de extensión para 09**
     (devolver conversaciones a "sin asignar"). La fila `user` se conserva
     (preserva `lead_stage_event.actor_user_id`, `schema.ts:275-277`).
   - `resetPassword(orgId, actorUserId, memberId)`: no a sí mismo (409);
     genera temporal con `nanoid` (16+ chars), hash con el hasher configurado
     (`(await getAuth().$context).password.hash`, mismo algoritmo que
     `scripts/reset-password.mjs`), `UPDATE account SET password=… WHERE user_id=… AND provider_id='credential'`,
     borra sesiones; devuelve la temporal una sola vez.
   - `createOrRelinkMember(...)`: si el correo existe como `user` sin membresía
     en la org → insertar `member` + `resetPassword`; si ya es miembro → 409.
10. **Rutas**: `settings/team/route.ts` (GET y POST owner, POST usa
    `createOrRelinkMember`); `settings/team/[memberId]/route.ts` (nuevo:
    `PATCH { role }`, `DELETE`); `settings/team/[memberId]/reset-password/route.ts`
    (nuevo: `POST`). Zod en todo body; respuestas `{ error: { code } }` vía
    `apiError`.
11. **`src/lib/auth/guards.ts` (nuevo)** — `requireOwnerPage()` para server
    components: `getSessionOrNull()` → `redirect("/login")` si no hay;
    `notFound()` si no es owner; devuelve la sesión.

### UI

- **Contexto de visor** — `src/components/viewer-context.tsx` (nuevo):
  `ViewerProvider` con `{ userId, name, role }` montado en `AppShell`
  (`app-shell.tsx`), alimentado desde `src/app/(app)/layout.tsx:29-41` (agregar
  `userId`). Hook `useViewer()`; lo reutiliza 09 (filtro "Mías", variable
  `{{vendedor}}`).
- **Menú** — `app-nav.tsx:35-41`: marcar `ownerOnly: true` en Agente y
  Laboratorio (y Reportes cuando llegue) y filtrar en `items` (`:117-119`);
  `:274` usa `roleLabel(role)`. El engrane (`:237`) se queda para ambos.
- **Páginas Propietario** — route groups (no cambian URLs):
  - `src/app/(app)/(owner)/layout.tsx` (nuevo) con `await requireOwnerPage()`;
    mover ahí `agent/` y `lab/` (y luego `reports/` de 02).
  - `src/app/(app)/settings/(owner)/layout.tsx` (nuevo) igual; mover ahí
    `whatsapp/`, `instagram/`, `messenger/`, `branding/`, `templates/`,
    `team/`, `calendar/`, `ads/`. Las guardas de bandera de cada página siguen
    igual.
  - Alternativa si no se quieren mover carpetas: `await requireOwnerPage()` al
    inicio de cada `page.tsx` (el test de §Pruebas lo vigila igual).
- **Ajustes** — `settings/layout.tsx` pasa a `async`, lee la sesión y pasa
  `role` a `SettingsNav`; `settings-nav.tsx:9-49` agrega la pestaña
  `{ href: "/settings/account", label: "Mi cuenta" }` para todos y oculta el
  resto si no es owner. `settings/page.tsx` redirige por rol.
- **Mi cuenta** — `src/app/(app)/settings/account/page.tsx` (nuevo) +
  `src/components/settings/account-client.tsx` (nuevo): nombre
  (`authClient.updateUser`), cambio de contraseña (`authClient.changePassword`
  con `currentPassword`, `newPassword` ≥ 8, `revokeOtherSessions: true`) y el
  `ThemeToggle` existente.
- **Equipo** — `team-client.tsx`: badge con `roleLabel` (`:156-157`), y por
  fila un menú "Hacer propietario/vendedor", "Restablecer contraseña" (modal
  que muestra la temporal una vez, como el alta) y "Dar de baja" (confirmación
  explícita). Deshabilitado en la fila propia con tooltip.
- **Componentes compartidos** (con `useViewer()`):
  - `contact-panel.tsx:254` — ocultar el enlace a `/agent` si no es owner.
  - `template-sender.tsx:54` y `start-conversation.tsx:88` — texto "Pide al
    propietario que cree una plantilla" en lugar del enlace.
  - `pipeline-client.tsx:178,213` — no renderizar "Gestionar etapas" ni
    `StageManager`.
  - `conversation-list.tsx:27` — ocultar "Cargar datos de demostración".
  - `app-shell.tsx`: ante 401 en fetch globales (badge de `app-nav.tsx:96-103`)
    → `router.replace("/login")`.

### Tareas ordenadas

- [x] T-00-01 `src/lib/roles.ts` (nuevo) + unit `tests/unit/roles.test.ts` (normalización, etiquetas).
- [x] T-00-02 `requireSession` devuelve `Role` normalizado (`session.ts:29-36`). Dep: 01.
- [x] T-00-03 `withAuth(..., { role })` + `requireOwner()` en `src/lib/api.ts`; unit `tests/unit/with-auth-role.test.ts` (mock de `@/lib/auth/session`). Dep: 02.
- [x] T-00-04 Aplicar la matriz a `settings/*`, `kb/*`, `lab/*`, `agent/profile` PUT, `pipeline/stages` POST/PATCH/DELETE, `templates` POST + `sync`, `calendar/settings`, `seed/demo`; retirar los 4 chequeos manuales. Dep: 03.
- [x] T-00-05 `GET /api/agent/profile` reducido para Vendedor. Dep: 03.
- [x] T-00-06 `src/lib/permissions.ts` (nuevo) con la tabla `ROUTE_POLICY` + `tests/unit/role-matrix.test.ts` (nuevo). Dep: 04.
- [x] T-00-07 Better Auth: bloquear `/organization/*`, `allowUserToCreateOrganization: false`, `disableOrganizationDeletion: true`; quitar `organizationClient()`. Unit sobre el hook. Dep: —.
- [x] T-00-08 `resolveMembership` con `ORDER BY`; schema + migración `0013_roles_miembros.sql` (dedupe + índice único); probar 2× en la BD aislada. Dep: —.
- [x] T-00-09 Bloqueo de login sin membresía en `session.create.before` respetando `runInternalSignup`; unit para: alta de equipo OK, primer registro OK, cuenta dada de baja 403. Dep: 08.
- [x] T-00-10 `src/server/team/members.ts` (nuevo) con `changeRole`, `removeMember` (+ hook `onMemberRemoved`), `resetPassword`, `createOrRelinkMember`; unit `tests/unit/team-members.test.ts` (último owner, self-change). Dep: 08.
- [x] T-00-11 Rutas `settings/team/[memberId]` y `.../reset-password` (nuevas); POST de alta usa re-link. Dep: 10.
- [x] T-00-12 `/api/events`: `lab.run` solo a owner. Dep: 02.
- [x] T-00-13 `requireOwnerPage()` + route groups `(owner)` en `(app)/` y `settings/`; `settings/page.tsx` por rol. Dep: 02.
- [x] T-00-14 `ViewerProvider` + `useViewer()`; `layout.tsx` pasa `userId`. Dep: 02.
- [x] T-00-15 Menú y `SettingsNav` por rol; `roleLabel` en `app-nav.tsx:274` y `team-client.tsx:156`. Dep: 13, 14.
- [x] T-00-16 "Mi cuenta" (página + client) con cambio de nombre y contraseña. Dep: 13.
- [x] T-00-17 Equipo UI: cambiar rol, baja, restablecer contraseña. Dep: 11.
- [x] T-00-18 Componentes compartidos sin enlaces de Propietario (contact-panel, template-sender, start-conversation, pipeline-client, conversation-list). Dep: 14.
- [x] T-00-19 E2E `scripts/e2e-roles.mjs` (nuevo) + guion `tests/e2e/us-roles.md` (nuevo); actualizar `tests/e2e/us7-team.md`. Dep: todas.
- [x] T-00-20 Gate completo `pnpm typecheck && pnpm lint && pnpm build && pnpm test` + `pnpm test:e2e` (el selftest corre como owner y debe seguir verde) + `e2e-roles.mjs` contra BD aislada (`.env.e2e`). Actualizar `dev-tasks/README.md` con el commit.

### Pruebas

**Unit (`tests/unit/`)**
- `roles.test.ts`: `normalizeRole("owner")→owner`; `"member"`, `"admin"`,
  `""`, `"OWNER"` → `member`.
- `with-auth-role.test.ts`: `vi.mock("@/lib/auth/session")`; Vendedor + guarda
  owner → 403 y el handler **no** se llama (spy); owner → 200; sin sesión → 401.
- `role-matrix.test.ts` (guardarraíl estilo `stage-history-guard.test.ts`):
  1. Recorre `src/app/api/**/route.ts`, extrae los métodos exportados
     (`export const GET =` / `export async function POST`).
  2. Cada `"METHOD ruta"` debe existir en `ROUTE_POLICY`
     (`src/lib/permissions.ts`); falla listando las no clasificadas.
  3. Si la política es `owner`, el bloque del export debe contener
     `{ role: "owner" }`; si es `any`/`any*`, `withAuth(`; `bot` →
     `requireBotKey`; `dev` → `mockGuard`; `public` → lista blanca explícita.
  4. Cada carpeta de página bajo `(owner)` hereda el layout con
     `requireOwnerPage` (o, en la alternativa, cada `page.tsx` listado como
     Propietario lo llama).
- `team-members.test.ts`: último owner (409), self-change (409),
  concurrencia (dos `changeRole` en paralelo sobre dos owners → uno falla),
  baja borra sesiones y llama `onMemberRemoved`.
- `auth-org-block.test.ts`: el middleware rechaza `/organization/create`,
  `/organization/update-member-role`, `/organization/delete`; deja pasar
  `/sign-in/email`, `/change-password`, `/update-user`.

**E2E — `scripts/e2e-roles.mjs` (nuevo; mismo patrón de cookie jar que
`scripts/e2e-handoff-nota.mjs:20-55`, dos jars: owner y vendedor)**
1. Owner entra (`/api/auth/sign-in/email`), crea vendedor con
   `POST /api/settings/team`.
2. Vendedor entra; recorre una tabla de ~25 llamadas `owner` y espera 403 en
   todas; relee como owner que nada cambió (prompt, credenciales, etapas).
3. Vendedor: 200 en `GET /api/conversations`, `GET /api/pipeline/board`,
   `PATCH /api/pipeline/leads/:id` (mover), `GET /api/templates`,
   `GET /api/agent/profile` sin `instructions`.
4. `POST /api/auth/organization/create` (ambos) → 404; sigue habiendo 1 org.
5. Playwright (como `scripts/e2e-responsive.mjs:18,61-62`): vendedor en
   `/inbox` → el lateral no tiene "Agente"/"Laboratorio"; `/agent`, `/lab`,
   `/settings/whatsapp` → 404; `/settings` → `/settings/account`; cambia su
   contraseña y vuelve a entrar.
6. Gestión: owner restablece la contraseña del vendedor (la vieja falla, la
   temporal entra); owner intenta degradarse → 409; owner promueve al
   vendedor, ambos owners, uno se degrada → OK, el último no → 409; vuelve a
   vendedor.
7. Camino infeliz: owner da de baja al vendedor con su sesión abierta → la
   siguiente petición del vendedor 401; login 403; re-alta del mismo correo
   → 201 y entra con la nueva temporal.
- Guion humano `tests/e2e/us-roles.md` (nuevo) con los mismos pasos; extender
  `tests/e2e/us7-team.md` (paso 3 ya verifica "member no crea cuentas").
- El selftest `scripts/e2e-selftest.mjs` corre como el owner
  `e2e@vocero.test` (`:73-85`): debe seguir verde sin cambios; agregarle una
  sección corta "roles" que solo verifique `POST /api/auth/organization/create`
  → 404 (lo demás vive en `e2e-roles.mjs` para no inflar el arnés).

### Riesgos y decisiones abiertas

- **Riesgo — romper el alta de equipo** con el bloqueo de login sin membresía
  (la sesión nace antes del `insert member`): mitigado con
  `isInternalSignup()` y test dedicado.
- **Riesgo — un endpoint olvidado**: mitigado por `role-matrix.test.ts`, que
  obliga a clasificar todo handler nuevo.
- **Riesgo — versión de Better Auth**: `package.json` pide `^1.1.14` pero hay
  1.6.23 instalado; `allowUserToCreateOrganization` y
  `disableOrganizationDeletion` existen en 1.6.x
  (`node_modules/better-auth/dist/plugins/organization/types.d.mts:22,292`).
  El bloqueo por `ctx.path` funciona en cualquier versión: es la defensa
  principal; las opciones son respaldo. Recomendado fijar el rango a `^1.6`.
- **Riesgo — 403 en API vs 404 en páginas**: la API devuelve 403 (la existencia
  del endpoint es pública: el código es open source); las páginas 404 (patrón
  ya usado con banderas).
- **Decisión abierta D-00-1 — ¿borrar la fila `user` en la baja?**
  Recomendado **no**: se conserva el usuario (sin membresía ni sesiones) para
  no perder el autor en `lead_stage_event.actor_user_id` (ON DELETE SET NULL,
  sin snapshot del nombre) ni la autoría futura de asignaciones; permite re-alta.
  Alternativa: borrar `user` (cascade a `session`/`account`) y aceptar perder
  la autoría histórica.
- **Decisión abierta D-00-2 — ¿varios Propietarios?** Recomendado **sí** (socio
  o agencia), con invariante ≥ 1. Alternativa: exactamente uno y "transferir
  propiedad".
- **Decisión abierta D-00-3 — ¿el Vendedor ve el tablero de Pipeline completo
  (montos de todos)?** Esta tarea lo deja en `any` porque así lo pidió el dueño
  ("mover leads y capturar monto SÍ"); si con la asignación (09) se decide
  restringir, se hará en la query del tablero.

## 3. Dependencias con otras tareas

- **Bloquea a todas** (ver `dev-tasks/README.md`): 02 (Reportes = owner,
  reutiliza `withAuth({ role: "owner" })`, el grupo `(owner)` y
  `ROUTE_POLICY`), 03/04 (cualquier endpoint nuevo se clasifica en la matriz),
  05/06 (filtros y alertas heredan el rol de la sesión), 08 (Laboratorio ya
  queda owner), 10.
- **09 (asignación)** depende de: `useViewer()` / `ViewerProvider`, `Role`,
  `requireOwner()`, y del hook `onMemberRemoved(orgId, userId, tx)` de
  `src/server/team/members.ts`, que 09 implementa para devolver las
  conversaciones del vendedor dado de baja a "sin asignar". Como aquí la fila
  `user` NO se borra, el `ON DELETE SET NULL` de 09 no basta: el hook es
  obligatorio. La política `any*` de conversaciones, media, eventos y
  `start-conversation` la completa 09.
