# E2E — Leads externos: formulario web y FastApp (011)

Guion de comportamiento observable. Automatizado en
`scripts/e2e-leads-externos.mjs` (recorrido completo, HTTP + Playwright) y, lo
esencial, en la sección `011` de `scripts/e2e-selftest.mjs` (`pnpm test:e2e`).
Ambos salen distinto de cero si algo falla.

**Preparación**: app en `localhost` con `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL` → ai-mock,
`BOT_API_KEY` y la BD migrada (BD aislada, nunca la de `.env`). Exporta
`CATALOG_STORAGE=local` en el server y en el guion. La bandera
`LEADS_EXTERNOS` decide qué mitad corre — **las dos se ejercitan**, y debe
llegar con el mismo valor al server Y al proceso del guion:

```bash
CATALOG_STORAGE=local LEADS_EXTERNOS=on  node --env-file=.env.e2e scripts/e2e-leads-externos.mjs
CATALOG_STORAGE=local LEADS_EXTERNOS=off node --env-file=.env.e2e scripts/e2e-leads-externos.mjs
```

El "ERP" del guion es el propio script: hace `POST /api/intake/lead` con
`X-API-Key`, como lo hará el trigger `pg_net` del ERP. Nada de esto toca Meta.

---

## US0 — La instancia decide si esto existe

Con `LEADS_EXTERNOS` apagada:

1. `POST /api/intake/lead` → **404**, con o sin clave, con o sin cuerpo.
2. `GET`/`PUT`/`DELETE /api/settings/intake` (Propietario) → **404**.
3. `/settings/leads-externos` → 404 y la pestaña «Leads externos» no aparece
   en Ajustes (las demás sí).

## US2 — El Propietario genera la clave

1. Vendedor: `GET`/`PUT`/`DELETE /api/settings/intake` → **403**; sin sesión → 401.
2. Sin clave configurada, `GET` responde `intake: null` y la URL de entrada
   (`<APP_BASE_URL>/api/intake/lead`); el endpoint responde **401** a todo.
3. `PUT` genera la clave: 43 caracteres base64url, completa **una sola vez**
   (`cache-control: no-store`); después la vista solo trae los últimos 4.
4. En la UI, «Rotar clave» la muestra completa con el SQL para el Vault del
   ERP; al recargar ya no aparece. La clave anterior deja de valer al instante.
5. «Revocar» → el endpoint vuelve a 401 y Ajustes queda sin clave.
6. Un Vendedor no ve la pestaña ni la página.

## US1 — Llega un lead y aparece en la Bandeja

1. Clave incorrecta → 401 sin detalle; cuerpo no JSON / sin `lead_id` / origen
   fuera de `website|fast_app` → 422; teléfono no mexicano reconocible → 422
   `invalid_phone`.
2. Lead `website` con teléfono `55 1234 5678` → **201** `{ contactId,
   conversationId, created: true }`:
   - contacto con teléfono `52` + 10 y el nombre del lead en `name`;
     `profileName` queda **null** (es el nick del canal y el formulario no
     es WhatsApp);
   - conversación **sin asignar**, un no leído, `lastInboundAt` intacto y el
     compositor en **modo plantilla**;
   - una tarjeta `lead_intake` entrante: «Lead del sitio web» + correo,
     vehículo, sucursal, presupuesto, código (los campos desconocidos se
     ignoran);
   - lead en Seguimiento, fuente capturada «Sitio web», correo en la ficha con
     procedencia `externo`.
3. Con la Bandeja abierta, un lead nuevo aparece **en vivo** y, entre una
   pestaña en primer plano y otra en segundo, sale **una** alerta con el
   nombre del lead. El hilo pinta la tarjeta y el compositor dice «La ventana
   de 24 horas está cerrada.».
4. El Vendedor la ve en «sin asignar» y lee sus mensajes.

## US1b — Idempotencia y el mismo prospecto por dos vías

1. Mismo `lead_id` otra vez → **200** `{ duplicate: true }`: una sola tarjeta y
   un solo no leído (esto permite el cron de conciliación del ERP).
2. El mismo teléfono por `fast_app` (`+52 1 55 …`) → 201 `created: false`,
   **misma** conversación, dos tarjetas (la segunda «Lead de promotor
   (FastApp)» con el promotor). La fuente ya capturada y el nombre no cambian,
   y `profileName` sigue null.
3. (022) Con la conversación **archivada**, un lead nuevo del mismo teléfono la
   desarchiva (archivedAt/motivo en null) y vuelve a «Todas», como un entrante
   de WhatsApp. Un `lead_id` repetido (duplicado) **no** la desarchiva.
4. Un lead **sin nombre** (`first_name` ausente o vacío) → **201**, no se
   rechaza: el contacto conserva su nombre de respaldo (el teléfono `52…`) y
   la tarjeta dice «Nombre: (sin nombre)».

## US1c — Lo que NO hace

1. El agente (encendido) **no corre**: sin salientes y sin escalamiento por
   ventana (`handoffAt` null).
2. Métricas del agente: activas (M1/M2), sesiones (M4) y entrantes (M8) **no
   cambian** por las tarjetas.
3. `/api/bot/typing` con solo tarjetas → `no_inbound` (ignora `intake:%`).
4. Logs: solo `lead_id`, origen y últimos 4 del teléfono — nunca la clave ni
   el payload.

## US3 — El prospecto escribe por WhatsApp después

1. Un entrante del wa-mock desde `521…` cae en la **misma** conversación: la
   ventana se abre (`replyMode free`), sigue habiendo un solo contacto con ese
   teléfono y su nombre se conserva (no lo pisa el nombre de perfil, que va a
   `profileName`).
2. Ahora el agente sí responde, y `/api/bot/typing` encuentra el entrante real.

## Límite de tasa

1. Más de 20 intentos con clave mala desde una IP (`X-Forwarded-For`) en un
   minuto → **429** `rate_limited` para esa IP; una petición con la clave
   buena desde otra IP sigue pasando (**201**).
2. Al final (agota el cupo del minuto): más de 120 peticiones AUTENTICADAS
   por minuto → **429** `rate_limited` (cupo global, solo autenticadas).
