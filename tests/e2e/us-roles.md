# Guion E2E — Roles y permisos (Propietario / Vendedor)

> Tarea `dev-tasks/00-roles-y-permisos.md`. Automatizado en
> `scripts/e2e-roles.mjs` (HTTP real + Playwright, dos cookie jars):
>
> ```bash
> # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock)
> # y BD migrada (0013 incluida); en local, la BD aislada de .env.e2e
> node --env-file=.env.e2e scripts/e2e-roles.mjs
> ```
>
> El limitador de login es en memoria por IP (10 / 10 min en `/sign-in/email`
> y `/sign-up/email`). El guion gasta ≤ 7 inicios de sesión y Playwright
> reutiliza las cookies, así que cabe en UNA corrida: para correrlo dos veces
> seguidas (o después de otro guion), **reinicia el servidor** antes. Corre
> igual sobre BD vacía (primer registro) o con el owner `e2e@vocero.test` ya
> creado (login); el vendedor y el socio llevan sufijo aleatorio.

## a) Primer registro

1. En una instancia vacía, registrar `e2e@vocero.test`.
   ✅ Se crean la organización y la membresía `owner`; hay exactamente 1
   organización. (Re-corrida: el owner inicia sesión.)

## b) Alta de vendedor

2. Ajustes → Equipo → crear cuenta (nombre, correo, contraseña temporal).
   ✅ `POST /api/settings/team` → 201; aparece como "Vendedor".
3. El vendedor inicia sesión con la temporal.
   ✅ Entra (el bloqueo de cuentas dadas de baja NO rompe el alta de equipo).

## c) Lo que el vendedor NO puede (API)

4. Con la sesión del vendedor, llamar ~35 endpoints de Propietario
   (`settings/*` de WhatsApp, webhook, Instagram, Messenger, CAPI, Google,
   Zoom, marca, favicon; `kb/*`; `lab/*`; `PUT agent/profile`;
   `pipeline/stages` POST/PATCH/DELETE; `templates` POST y `sync`;
   `calendar/settings`; `seed/demo`; `settings/team` GET/POST/PATCH/DELETE/reset).
   ✅ Todos 403 `forbidden`, también con body inválido (la guarda corre antes
   de validar). El owner relee prompt, credenciales, etapas, KB, plantillas,
   equipo y agenda: nada cambió.
5. Operación diaria del vendedor.
   ✅ 200 en `GET /api/conversations`, `GET /api/pipeline/board`,
   `PATCH /api/pipeline/leads/:id` (mueve la tarjeta), `GET /api/templates`.
   ✅ `GET /api/agent/profile` devuelve solo `{ profile: { enabled }, aiConfigured }`.

## d) Plugin `organization`

6. `POST /api/auth/organization/create` (owner y vendedor) y
   `.../update-member-role` (vendedor).
   ✅ 404; sigue habiendo 1 organización y ningún rol cambió.

## h) Lo que ve cada rol (navegador)

7. Vendedor en `/inbox`.
   ✅ El lateral no tiene "Agente" ni "Laboratorio".
8. Vendedor abre `/agent`, `/lab`, `/settings/whatsapp`, `/settings/team`,
   `/settings/templates`.
   ✅ 404 de la app. `/settings` lo lleva a `/settings/account`, sin pestaña
   "Equipo".
9. Vendedor en "Mi cuenta" cambia su nombre.
   ✅ "Nombre guardado ✓"; el lateral y Ajustes → Equipo (del owner) muestran
   el nombre nuevo.
10. Owner (control positivo).
    ✅ Ve "Agente" y "Laboratorio"; esas páginas dan 200; `/settings` →
    `/settings/whatsapp`.

## e) Gestión de equipo

11. Owner promueve al vendedor a Propietario y lo regresa a Vendedor.
    ✅ 200 ambas; el cambio surte efecto en la siguiente petición del
    afectado (sin re-login).
12. Owner intenta cambiar su propio rol o darse de baja.
    ✅ 409 `self_change`.
13. Con dos Propietarios, cada uno degrada al otro A LA VEZ.
    ✅ Exactamente una petición 200 y la otra 409 `last_owner`; queda un
    Propietario. (Con un solo Propietario, `last_owner` no es alcanzable por
    la API: el actor es owner y no puede tocarse a sí mismo.)

## f) Restablecer contraseña

14. Owner → "Restablecer contraseña" del vendedor.
    ✅ Muestra una temporal (≥ 16 caracteres) una sola vez; la sesión abierta
    del vendedor responde 401; la contraseña vieja ya no entra y la temporal
    sí. Restablecer la propia por aquí → 409 `self_change`.

## g) Baja y re-alta (camino infeliz)

15. Con el vendedor con sesión abierta, el owner lo da de baja.
    ✅ Su siguiente petición → 401 (la Bandeja lo manda a `/login`); su login
    → 403 "Tu acceso fue dado de baja; pide al Propietario que te reactive".
16. El owner vuelve a dar de alta el mismo correo.
    ✅ 201 `relinked: true`; entra con la nueva contraseña y opera. Dar de
    alta otra vez a un miembro activo → 409 `duplicate`.

## Migración 0013 (manual, BD aislada)

- Tras reset + migrate existe `member_org_user_uq (organization_id, user_id)`.
- Re-ejecución: borrar la fila de 0013 en `drizzle.__drizzle_migrations` y
  volver a migrar → sin error.
- Dedupe: aplicar hasta 0012 (`MIGRATIONS_DIR` con el journal recortado),
  sembrar membresías duplicadas y aplicar 0013 → por par se conserva la fila
  `owner`; a igualdad, la más antigua; a igualdad de fecha, el menor `id`.
