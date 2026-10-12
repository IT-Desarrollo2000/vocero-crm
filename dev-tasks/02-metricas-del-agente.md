# 02 — Métricas del agente

> Estado: en curso (contrato 05/02-0 fijado; migración oficial `0017`) · Prioridad: media · Esfuerzo: M (V1) / L (V2) · Migración: sí (tentativa `0016`, siguiente libre tras 00/09/06: índice de `message`; en V2 además tabla `conversation_handoff_event` con siembra) · Bandera: no (núcleo; visible solo para Propietario)
>
> **Manda la sección [«Contrato 05/02-0»](#contrato-0502-0)** sobre cualquier
> detalle anterior que la contradiga (helper `markHandoff`, evento
> `conversation.handoff`, tabla `conversation_handoff_event` con `created_at`
> como hora del evento, migración `0017`, regla de `manual_reply`).
>

## 1. Especificación

### Problema / objetivo

El dueño no tiene forma de saber si el agente de IA está funcionando: cuántas
conversaciones resuelve solo, cuántas escala y por qué, qué tan rápido
contesta (la IA y su equipo), cuántos mensajes fallan y si los clientes los
reciben y leen. Hoy no existe ninguna pantalla de reportes ni de métricas
(menú en `src/components/app-nav.tsx:35-41`).

Objetivo: una sección **Reportes → Agente**, solo para el **Propietario**, con
rango de fechas (7/30/90 días o personalizado) y métricas definidas con
precisión en SQL, excluyendo siempre el Laboratorio (`is_test`). La sección se
diseña como marco reutilizable para el futuro reporte de ventas (punto 1) y de
ventas por anuncio (07).

### Alcance (incluye) / Fuera de alcance

Incluye:
- Página `/reports` (pestaña «Agente») y `GET /api/reports/agent`.
- Selector de rango: 7, 30, 90 días y personalizado (máx. 366 días), en la zona
  horaria del negocio.
- Métricas M1–M8 (definidas abajo): conversaciones activas, % atendidas solo por
  IA, escalamientos por motivo con muestra de notas, tiempo a primera respuesta
  (IA y humano; mediana y p90), % de salientes fallidas, tasa de entrega y de
  lectura, volumen por día y por canal.
- Índices para que escale; registro histórico de escalamientos (variante V2).
- Ocultar menú y responder 403 a la API para el Vendedor.

Fuera de alcance:
- Reporte de ventas (punto 1) y por anuncio (07): solo se deja el marco.
- Comparación contra el periodo anterior, exportar CSV, reportes por correo
  (prohibido por soberanía de todos modos).
- Métricas por vendedor (dependen de 09; se agregan después como otro corte).
- Métricas del Laboratorio (ya tiene su pantalla).
- Tiempo a lectura/entrega (no hay marcas de tiempo por estado; ver D-02-4).

### Historias de usuario

- Como **Propietario** quiero ver qué porcentaje de conversaciones resolvió el
  agente sin ayuda, para decidir si vale lo que pago por el modelo.
- Como **Propietario** quiero ver por qué escala el agente, con ejemplos reales
  de la nota que dejó, para ajustar el prompt o la base de conocimiento.
- Como **Propietario** quiero saber cuánto tarda en responder la IA y cuánto mi
  equipo, para detectar cuellos de botella.
- Como **Propietario** quiero ver cuántos mensajes fallan y cuántos se
  entregan y leen, para detectar problemas con el número o las plantillas.
- Como **Propietario** quiero ver el volumen diario por canal, para saber
  cuándo y por dónde me escriben.
- Como **Vendedor** NO debo ver esta sección (decisión del dueño).

### Requisitos funcionales

- **RF-02-01** `GET /api/reports/agent?range=7|30|90` o
  `?from=YYYY-MM-DD&to=YYYY-MM-DD` (días calendario en la zona del negocio,
  `to` inclusive) devuelve el reporte M1–M8. Rango inválido (`from > to`, fecha
  ilegible, > 366 días) → 422 `invalid_range`. Sin parámetros → 30 días.
- **RF-02-02** Solo Propietario: un Vendedor recibe 403 `forbidden` en la API;
  la página `/reports` responde 404 para él y el menú no muestra «Reportes».
- **RF-02-03** Todas las métricas excluyen conversaciones `is_test = true`.
- **RF-02-04** Cada métrica se calcula exactamente con la fórmula de la tabla
  de definiciones (abajo); la respuesta incluye la zona horaria y los límites
  UTC usados.
- **RF-02-05** Métricas con denominador 0 se devuelven como `null` y la UI
  muestra «—» (nunca `NaN` ni 0 %).
- **RF-02-06** Escalamientos: conteo por motivo con etiqueta en español
  (`src/lib/handoff-labels.ts:16-23`) y hasta 5 notas recientes por motivo
  (`handoffNote`) con nombre del contacto y enlace a `/inbox?contact=<id>`.
- **RF-02-07** Volumen: una fila por día del rango (también los días en cero) ×
  canal, con entrantes y salientes.
- **RF-02-08** La consulta completa termina en < 2 s para 90 días con 100 000
  mensajes; si supera 15 s se corta y la API responde 503
  `report_timeout` con mensaje «Prueba un rango más corto».
- **RF-02-09** La pantalla recuerda el último rango en la URL (`?range=30`),
  para poder compartir el enlace entre propietarios.

### Definiciones de métricas (fórmulas)

Convenciones: `:org` organización; `:from`/`:to` límites UTC del rango
(`[from, to)`), calculados desde días locales en `:tz`; todo límite derivado
(`:fromLookback`, `:cutoff`) se calcula en Node y viaja como parámetro — nunca
`now()` ni aritmética de intervalos contra columnas `timestamp` sin zona, que
dependen del `TimeZone` de la sesión de Postgres (mismo criterio que
`window.ts:10-16`); todas las consultas
unen `message m` con `conversation c on c.id = m.conversation_id` y filtran
`m.organization_id = :org and c.is_test = false`. Columna de tiempo:
`m.created_at` (indexable; en operación real difiere de `wa_timestamp` en
segundos). «Humano» = saliente con `origin in ('operator','manual','template')`
— `manual` es la respuesta desde la app del teléfono (`ingest.ts:325`);
«IA» = `origin = 'ai'`, que incluye al cerebro externo de `/api/bot/*`
(`send.ts:389`). Salientes `failed` no cuentan como respuesta.

| # | Métrica | Definición |
|---|---|---|
| M1 | Conversaciones activas | Conversaciones con ≥ 1 entrante en el rango. |
| M2 | Reparto de atención | De las activas: **Solo IA** = ≥ 1 saliente IA no fallida en el rango, 0 salientes humanas en el rango y 0 escalamientos abiertos en el rango · **IA + humano** = ≥ 1 IA y (≥ 1 humana o escalamiento) · **Solo humano** = 0 IA y ≥ 1 humana · **Sin respuesta** = 0 salientes no fallidas. `% solo IA = solo_ia / activas`. |
| M3 | Escalamientos por motivo | V2: eventos `opened` de `conversation_handoff_event` con `occurred_at` en el rango, agrupados por `reason`. V1: conversaciones con `handoff_at` en el rango (aproximado, ver D-02-1). |
| M4 | Tiempo a primera respuesta | Por **sesión**: una sesión empieza con un entrante cuyo mensaje anterior en la conversación (cualquier dirección) tiene ≥ 24 h, o no existe. Respuesta = primer saliente no fallido posterior. Se agrupa por quién respondió (IA / humano); mediana y p90 en segundos. Sesiones sin respuesta se cuentan aparte. |
| M5 | Tiempo humano tras escalamiento (solo V2) | Por evento `opened` **con `approximate = false`** (los sembrados cuentan para M3 pero jamás para promedios de tiempo, igual que `lead_stage_event`, `schema.ts:284-286`): hasta el primer saliente humano posterior en esa conversación. Mediana y p90; los no atendidos se cuentan aparte. |
| M6 | % salientes fallidas | `failed / total` de salientes creadas en el rango; corte por `origin` y canal; top 5 de `error`. |
| M7 | Entrega y lectura | Solo canales con `deliveryReceipts = true` (hoy WhatsApp, `capabilities.ts:65`; Instagram `:78` y Messenger `:94` nacen `sent`). Excluye `origin = 'manual'` y mensajes de los últimos 15 min. `entrega = (delivered + read) / (sent + delivered + read + failed)`; `lectura = read / (delivered + read)` — cota inferior: quien apaga las confirmaciones de lectura nunca pasa a `read`. |
| M8 | Volumen | Mensajes por día local × canal × dirección. |

SQL de referencia (se implementa con `sql` de Drizzle, parámetros enlazados):

```sql
-- M1 + M2: reparto de atención
with act as (
  select m.conversation_id,
    bool_or(m.direction = 'in')                                        as has_in,
    bool_or(m.direction = 'out' and m.origin = 'ai' and m.status <> 'failed') as has_ai,
    bool_or(m.direction = 'out' and m.origin in ('operator','manual','template')
            and m.status <> 'failed')                                  as has_human
  from message m join conversation c on c.id = m.conversation_id
  where m.organization_id = :org and c.is_test = false
    and m.created_at >= :from and m.created_at < :to
  group by m.conversation_id
), esc as (                                  -- V2; en V1: conversation.handoff_at en rango
  select distinct conversation_id from conversation_handoff_event
  where organization_id = :org and kind = 'opened'
    and occurred_at >= :from and occurred_at < :to
)
select
  count(*)                                                                   as activas,
  count(*) filter (where has_ai and not has_human and e.conversation_id is null) as solo_ia,
  count(*) filter (where has_ai and (has_human or e.conversation_id is not null)) as ia_y_humano,
  count(*) filter (where not has_ai and has_human)                           as solo_humano,
  count(*) filter (where not has_ai and not has_human)                       as sin_respuesta
from act left join esc e using (conversation_id)
where has_in;

-- M4: tiempo a primera respuesta por sesión
with msgs as (
  select m.conversation_id, m.direction, m.created_at,
         lag(m.created_at) over (partition by m.conversation_id order by m.created_at) as prev_at
  from message m join conversation c on c.id = m.conversation_id
  where m.organization_id = :org and c.is_test = false
    and m.created_at >= :fromLookback and m.created_at < :to   -- :fromLookback = from - 24 h, calculado en Node
), ses as (
  select conversation_id, created_at as started_at from msgs
  where direction = 'in' and created_at >= :from
    and (prev_at is null or created_at - prev_at >= interval '24 hours')
), fr as (
  select s.started_at, r.created_at as replied_at, r.origin
  from ses s left join lateral (
    select m.created_at, m.origin from message m
    where m.organization_id = :org and m.conversation_id = s.conversation_id
      and m.direction = 'out' and m.status <> 'failed' and m.created_at > s.started_at
    order by m.created_at limit 1
  ) r on true
)
select case when origin is null then 'sin_respuesta'
            when origin = 'ai' then 'ia' else 'humano' end as quien,
       count(*) as sesiones,
       percentile_cont(0.5) within group (order by extract(epoch from replied_at - started_at)) as p50_s,
       percentile_cont(0.9) within group (order by extract(epoch from replied_at - started_at)) as p90_s
from fr group by 1;

-- M6: fallidas
select c.channel, m.origin, count(*) as total,
       count(*) filter (where m.status = 'failed') as fallidas
from message m join conversation c on c.id = m.conversation_id
where m.organization_id = :org and c.is_test = false and m.direction = 'out'
  and m.created_at >= :from and m.created_at < :to
group by 1, 2;

-- M7: entrega/lectura (:channels = canales con deliveryReceipts, desde el código)
select count(*) filter (where m.status in ('delivered','read'))            as entregados,
       count(*) filter (where m.status = 'read')                           as leidos,
       count(*) filter (where m.status in ('sent','delivered','read','failed')) as base_entrega
from message m join conversation c on c.id = m.conversation_id
where m.organization_id = :org and c.is_test = false and m.direction = 'out'
  and m.origin <> 'manual' and c.channel = any(:channels)
  and m.created_at >= :from and m.created_at < :cutoff;  -- :cutoff = min(to, ahora - 15 min), calculado en Node

-- M8: volumen por día local (columnas `timestamp` sin zona, guardadas en UTC)
select ((m.created_at at time zone 'UTC') at time zone :tz)::date as dia,
       c.channel, m.direction, count(*) as n
from message m join conversation c on c.id = m.conversation_id
where m.organization_id = :org and c.is_test = false
  and m.created_at >= :from and m.created_at < :to
group by 1, 2, 3;   -- los días sin mensajes se rellenan en Node
```

### Permisos por rol

| Recurso | Propietario: ver | Propietario: editar | Vendedor: ver | Vendedor: editar |
|---|---|---|---|---|
| Menú «Reportes» | Sí | — | No (oculto) | — |
| Página `/reports` | Sí | — | No (404) | — |
| `GET /api/reports/agent` | Sí | — | No (403) | — |
| Muestra de notas de escalamiento | Sí | — | No | — |

### Criterios de aceptación

- **CA-02-01** Dado un rango de 30 días con 4 conversaciones activas (A
  contestada solo por IA, B escalada por el cliente con nota, C contestada por
  un operador con la IA apagada, D sin respuesta) y una corrida del
  Laboratorio, cuando el Propietario abre Reportes → Agente, entonces ve
  4 activas, «Solo IA» 25 %, 1 escalamiento «El cliente pidió un humano» con
  la nota de B, y nada del Laboratorio.
- **CA-02-02** Dado que la IA respondió A a los 4 s y el operador respondió C a
  los 10 min, cuando miro tiempos de respuesta, entonces IA mediana ≈ 4 s y
  humano mediana ≈ 10 min, y D aparece en «sin respuesta».
- **CA-02-03** Dado 10 salientes de WhatsApp (6 leídas, 2 entregadas, 1
  enviada, 1 fallida), entonces fallidas = 10 %, entrega = 80 %, lectura = 75 %;
  los salientes de Instagram no entran en entrega/lectura pero sí en fallidas.
- **CA-02-04** Dado un mensaje de hace 40 días, cuando elijo 30 días no cuenta;
  con 90 días sí; el gráfico diario de 90 días tiene 90 barras aunque haya días
  vacíos.
- **CA-02-05** Dado un Vendedor, cuando pide `GET /api/reports/agent` recibe
  403; cuando navega a `/reports` ve 404; el menú no tiene «Reportes».
- **CA-02-06** Dado `from=2026-10-10&to=2026-10-01`, entonces 422
  `invalid_range`; dado un rango de 400 días, 422.
- **CA-02-07** Dado una organización sin mensajes, entonces todas las tarjetas
  muestran «—» o 0 con texto «Aún no hay datos en este rango», sin errores.
- **CA-02-08** (V2) Dado que el agente escaló, alguien reactivó la IA y volvió a
  escalar por otro motivo dentro del rango, entonces M3 cuenta 2
  escalamientos (uno por motivo).

### Casos borde y degradación

- **Handoff limpiado o sobrescrito** (`queries.ts:136-141`,
  `bot/reset/route.ts:53-56`, re-escalamiento): en V1 se pierde el histórico
  (M3 subcuenta); en V2 queda en el registro. Ver D-02-1.
- **Mensajes `pending` viejos** (sin webhook de estado): no cuentan como
  entregados; aparecen en una línea «sin confirmar» para no inflar fallidas.
- **Confirmaciones de lectura apagadas** por el cliente: lectura es cota
  inferior; la UI lo dice en un tooltip.
- **Zona horaria**: con la agenda apagada no hay zona configurada; se usa la
  decisión D-02-2. Cambio de horario de verano: el `::date` en `:tz` lo
  resuelve Postgres.
- **Rango muy grande o BD lenta**: `SET LOCAL statement_timeout = '15s'` dentro
  de una transacción de solo lectura; al vencer → 503 y la UI ofrece «Probar
  con 30 días».
- **Fallo de una métrica**: cada bloque se calcula por separado
  (`Promise.allSettled`); un bloque que falla se muestra «No disponible» y los
  demás se pintan.
- **Conversación borrada** (cascade): sus mensajes desaparecen de las métricas
  pasadas; aceptado (el CRM no tiene soft-delete de conversaciones).
- **Laboratorio**: el `join conversation ... is_test = false` es obligatorio en
  TODAS las consultas; un unit test lo vigila.

## 2. Plan técnico

### Estado actual

- No hay rutas `/api/reports` ni página de reportes/métricas; menú en
  `src/components/app-nav.tsx:35-48` (`NAV` + `AGENDA_ITEM`), ya recibe
  `role` (`:53`) y pinta «Propietario» si `role === "owner"` (`:274`).
- Rol: `withAuth` no acepta opciones de rol (`src/lib/api.ts:17-37`); el patrón
  actual es `if (session.role !== "owner")` en
  `src/app/api/settings/team/route.ts:43` y `settings/branding/route.ts:25`.
  La tarea 00 introduce el helper (p. ej. `withAuth(..., { role: "owner" })`).
- Datos:
  - `message` (`src/lib/db/schema.ts:378-425`): `direction`, `status`
    (`pending|sent|delivered|read|failed`), `origin` (`ai|operator|manual|
    template`), `aiGenerated`, `error`, `waTimestamp`, `createdAt`. Único índice
    útil: `message_org_conv_idx (organization_id, conversation_id, created_at)`
    (`:418-424`) — **no** sirve para barrer un rango de fechas de toda la org.
  - `conversation` (`schema.ts:318-376`): `isTest`, `channel`, `aiEnabled`,
    `handoffAt`, `handoffReason` (enum `:345-356`), `handoffNote` (`:362`).
    Es un **estado**, no un historial: se limpia al reactivar
    (`src/server/inbox/queries.ts:136-141`) y en
    `src/app/api/bot/reset/route.ts:53-56`, y se sobrescribe al re-escalar.
  - Estados monotónicos sin marca de tiempo por estado
    (`src/server/inbox/status.ts:7-23`, `:57-60`).
  - Precedente de bitácora append-only con siembra aproximada:
    `lead_stage_event` (`schema.ts:244-316`, campo `approximate`).
  - Zona horaria: solo `calendar_settings.timezone` (`schema.ts:683`), que
    existe si la agenda está encendida.
- Escrituras de handoff (donde V2 registra): `applyHandoff`
  (`src/server/ai/pipeline.ts:325-356`, motivos en `:142`, `:148`, `:189`,
  `:264`, `:290`), pausa por respuesta manual (`src/server/inbox/ingest.ts:345-358`),
  cerebro externo (`src/app/api/bot/handoff/route.ts:64-77`); cierres en
  `queries.ts:136-141` (PATCH `reactivate`) y `bot/reset/route.ts:53-56`.
- Sin librería de gráficas en `package.json` (solo lucide, dnd-kit, etc.).
- Migraciones: drizzle en una transacción al arrancar (`scripts/migrate.mjs:149-156`);
  última `drizzle/0012_handoff_nota.sql`.

### Cambios de datos

Migración (número final según el orden con 00/09/06; editada a mano,
re-ejecutable, aditiva):

**V1 y V2 — índice de rango sobre mensajes:**
```sql
CREATE INDEX IF NOT EXISTS "message_org_created_idx"
  ON "message" ("organization_id", "created_at");
```
(Opcional, si `EXPLAIN` lo pide: `CREATE INDEX IF NOT EXISTS
"conversation_org_handoff_idx" ON "conversation" ("organization_id",
"handoff_at") WHERE "is_test" = false;` — solo V1.)

**Solo V2 — registro de escalamientos** (`conversation_handoff_event`, nuevo):
```sql
CREATE TABLE IF NOT EXISTS "conversation_handoff_event" (
  "id" text PRIMARY KEY,                                   -- newId("handoffEvent") → "hoe_…"
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "conversation_id" text NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,                                    -- 'opened' | 'closed'
  "reason" text,                                           -- enum de handoff_reason; null en 'closed'
  "note" text,
  "source" text NOT NULL,                                  -- 'agente' | 'bot_externo' | 'telefono' | 'operador' | 'sistema' | 'migracion'
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "occurred_at" timestamp NOT NULL DEFAULT now(),
  "approximate" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "hoe_org_occurred_idx" ON "conversation_handoff_event" ("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "hoe_conv_occurred_idx" ON "conversation_handoff_event" ("conversation_id", "occurred_at");

-- Siembra re-ejecutable: los handoffs abiertos hoy, marcados aproximados.
INSERT INTO "conversation_handoff_event"
  ("id","organization_id","conversation_id","kind","reason","note","source","occurred_at","approximate")
SELECT 'hoe_seed_' || c."id", c."organization_id", c."id", 'opened', c."handoff_reason",
       c."handoff_note", 'migracion', c."handoff_at", true
FROM "conversation" c
WHERE c."handoff_at" IS NOT NULL AND c."is_test" = false
ON CONFLICT ("id") DO NOTHING;
```
- Declarar tabla e índices en `schema.ts` (enums tipados contra
  `conversation.handoffReason`, igual que `handoff-labels.ts:12-14`); prefijo
  nuevo en `src/lib/db/ids.ts`. Las FK se desqualifican solas
  (`migrate.mjs:58-133`).
- Append-only: no se actualiza ni se borra (misma regla que `lead_stage_event`;
  un unit test de vigilancia como `stage-history-guard.test.ts` falla si
  aparece otra escritura fuera del helper).
- No se registran conversaciones `is_test` (sandbox).

### Servidor

1. **Helper único de handoff — `src/server/inbox/handoff.ts` (nuevo)**
   (compartido con 05): `markHandoff(...)` y `clearHandoff(...)`. En V2
   insertan el evento `opened`/`closed` en la misma transacción que el
   `UPDATE` de `conversation`. Se llaman desde `pipeline.ts:325-356`,
   `ingest.ts:345-358` (solo si `paused[0]`), `bot/handoff/route.ts:64-77`
   (solo si no había handoff), `queries.ts:136-141` (con `actorUserId` de la
   sesión) y `bot/reset/route.ts:53-56`.
2. **Marco de reportes — `src/server/reports/` (nuevo)**:
   - `range.ts`: `parseReportRange(params, tz)` → `{ fromUtc, toUtc,
     days: string[], tz, preset }` (Zod; presets 7/30/90; personalizado con
     días locales, `to` inclusive → `toUtc` = inicio del día siguiente;
     máx. 366 días). Reutilizable por ventas y anuncios.
   - `timezone.ts`: `reportTimezone(orgId)` según D-02-2.
   - `run.ts`: `runReport(fn)` abre transacción `READ ONLY` con
     `SET LOCAL statement_timeout = '15s'` y mapea el timeout a
     `ReportTimeoutError`.
   - `agent.ts`: `agentReport(orgId, range)` → ejecuta M1–M8 con
     `Promise.allSettled` (cada bloque `{ ok, data } | { ok: false }`); los
     canales con acuses salen de `CHANNEL_CAPABILITIES`
     (`src/server/channels/capabilities.ts:55-95`), no se hardcodean.
   - Futuro: `sales.ts` (punto 1, sobre `lead_stage_event`), `ads.ts` (07,
     sobre `ad_attribution`/`conversion_event`, detrás de `ATRIBUCION`).
3. **Tipos — `src/lib/reports.ts` (nuevo)**: `ReportRangeDto`,
   `AgentReportDto` (`{ range, attention, escalations: { byReason: [{ reason,
   label, count, samples: [{ conversationId, contactId, contactName, note,
   occurredAt }] }], approximate }, responseTimes, afterHandoff?, failures,
   delivery, volume }`), compartidos cliente/servidor.
4. **API — `src/app/api/reports/agent/route.ts` (nuevo)**:
   `withAuth(handler, { role: "owner" })` (helper de 00; mientras no exista,
   `if (session.role !== "owner") return apiError(403, "forbidden", …)`);
   422 `invalid_range`; 503 `report_timeout`; `Cache-Control: private,
   max-age=60`.
5. **Contrato**: agregar `GET /api/reports/agent` a
   `specs/001-vocero-core/contracts/api.md`.

### UI

- **Menú** (`app-nav.tsx:35-48`, `:117-119`): ítem `{ href: "/reports", label:
  "Reportes", icon: BarChart3, ownerOnly: true }` (lucide) después de
  «Contactos»; el filtro por `ownerOnly` sobre `items` lo introduce 00.
- **Página bajo el route group de 00**: `src/app/(app)/(owner)/reports/`
  (el `(owner)/layout.tsx` de 00 ya llama `requireOwnerPage()` → `notFound()`
  para el Vendedor; la URL sigue siendo `/reports`).
  - `src/app/(app)/(owner)/reports/layout.tsx` (nuevo): pestañas «Agente»
    (activa), «Ventas» y «Anuncios» (deshabilitadas con «Próximamente»;
    «Anuncios» solo si `ATRIBUCION` está encendida).
  - `src/app/(app)/(owner)/reports/page.tsx` (nuevo) → redirige a
    `/reports/agent`; `src/app/(app)/(owner)/reports/agent/page.tsx` (nuevo)
    monta el cliente.
- **`src/components/reports/` (nuevo)**, sin dependencias nuevas:
  - `range-picker.tsx`: botones 7/30/90 + «Personalizado» (dos
    `<input type="date">`); estado en la URL (`?range=` / `?from=&to=`).
  - `kpi-tile.tsx`: valor, etiqueta, ayuda (tooltip con la definición de la
    tabla) y estado vacío «—».
  - `attention-bar.tsx`: barra apilada Solo IA / IA + humano / Solo humano /
    Sin respuesta.
  - `escalations-table.tsx`: motivo, cantidad, % y notas de muestra con enlace
    a la Bandeja; aviso «Datos aproximados antes del <fecha de migración>»
    cuando haya eventos `approximate`.
  - `response-times.tsx`: mediana y p90 IA vs humano (formato «4 s», «12 min»,
    «1 h 5 min»).
  - `volume-chart.tsx`: barras SVG por día apiladas por canal (colores de canal
    existentes), eje con fechas locales; en móvil, desplazamiento horizontal
    dentro de la tarjeta (sin scroll de página).
  - `agent-report-client.tsx`: pide `/api/reports/agent`, maneja carga, 503
    («Prueba un rango más corto») y bloques «No disponible».

### Tareas ordenadas

- [ ] **T-02-01** Decidir V1/V2 (D-02-1) y zona horaria (D-02-2) con el dueño. *(—)*
- [ ] **T-02-02** Migración: índice `message_org_created_idx`; en V2 tabla
  `conversation_handoff_event` + índices + siembra; `schema.ts` + prefijo de id;
  `pnpm db:generate` sin diff. *(T-02-01)*
- [ ] **T-02-03** (V2) `src/server/inbox/handoff.ts` `markHandoff`/
  `clearHandoff` con inserción del evento; reemplazar las 5 escrituras/cierres;
  test de vigilancia append-only. *(T-02-02; si 05 ya creó el helper, solo se
  agrega la inserción)*
- [ ] **T-02-04** `src/server/reports/range.ts` + `timezone.ts` + `run.ts` con
  unit tests. *(T-02-01)*
- [ ] **T-02-05** `src/server/reports/agent.ts` M1–M8 + `src/lib/reports.ts`. *(T-02-02, T-02-04)*
- [ ] **T-02-06** `GET /api/reports/agent` con gate de Propietario. *(00, T-02-05)*
- [ ] **T-02-07** Ítem de menú `ownerOnly` + páginas en `(app)/(owner)/reports/`. *(00: T-00-13)*
- [ ] **T-02-08** Componentes de `src/components/reports/` + cliente. *(T-02-06, T-02-07)*
- [ ] **T-02-09** `EXPLAIN ANALYZE` con 100 000 mensajes sembrados en la BD de
  E2E; ajustar índices si algún bloque pasa de 500 ms. *(T-02-05)*
- [ ] **T-02-10** Pruebas (abajo), contrato `api.md`, gate `pnpm typecheck &&
  pnpm lint && pnpm build && pnpm test` + E2E en BD aislada. *(todo)*

### Pruebas

Unit (`tests/unit/`):
- `report-range.test.ts` (nuevo): presets; personalizado con `to` inclusive;
  `from > to`, fechas ilegibles y > 366 días → error; límites UTC correctos en
  `America/Mexico_City` y en una zona con horario de verano.
- `agent-report-sql.test.ts` (nuevo): vigilancia — cada consulta de
  `agent.ts` contiene el filtro `is_test = false` (inspeccionando el SQL
  generado por `.toSQL()`), y entrega/lectura usa la lista de canales de
  `CHANNEL_CAPABILITIES`.
- `agent-report-format.test.ts` (nuevo): ratios con denominador 0 → `null`;
  relleno de días vacíos; formato de duraciones.
- (V2) `handoff-event-guard.test.ts` (nuevo): ninguna escritura a
  `conversation_handoff_event` fuera de `src/server/inbox/handoff.ts`
  (patrón de `stage-history-guard.test.ts`).

E2E — **`scripts/e2e-metricas.mjs` (nuevo)** + guion
**`tests/e2e/us-metricas.md` (nuevo)**; app viva con mocks
(`WA_MOCK_ENABLED=true`, wa-mock + ai-mock, `BOT_API_KEY`), BD aislada
`.env.e2e` (Postgres :5433) reiniciada antes:
1. Propietario: inbound «A» → el agente (ai-mock) responde → Solo IA.
2. Inbound «B» con «quiero hablar con un humano» → ai-mock devuelve
   `handoff/cliente` (`src/server/dev/ai-mock.ts:50-52`); además
   `POST /api/bot/handoff` con nota en otra conversación para M3 con muestra.
3. «C»: `PATCH /api/conversations/:id {aiEnabled:false}` + inbound +
   `POST /api/conversations/:id/messages` del operador → Solo humano.
4. «D»: inbound con IA apagada y sin respuesta → Sin respuesta.
5. Estados: `POST /api/dev/wa-mock/status` para dejar salientes en
   `delivered`/`read`; un envío fallido (mecánica de
   `scripts/e2e-send-failure.mjs`).
6. Laboratorio: corrida corta (ai-mock) → nada de eso cuenta.
7. Mensaje de hace 40 días sembrado por SQL directo (como
   `e2e-alta-manual.mjs`, `DATABASE_URL=…?search_path=vocero`): fuera de 30,
   dentro de 90.
8. API: `GET /api/reports/agent?range=30` → números exactos de CA-02-01/03;
   `range=90` incluye el viejo; `from>to` → 422; 400 días → 422.
9. UI (Playwright, `waitUntil: "load"`): menú muestra «Reportes»; tarjetas con
   los mismos números; cambiar a 90 días actualiza la URL y el gráfico tiene 90
   barras; viewport 375 px sin scroll horizontal de página.
10. Camino infeliz por rol: cuenta Vendedor (invitación de
    `/api/settings/team`) → menú sin «Reportes», `/reports` = 404,
    `GET /api/reports/agent` = 403. Organización sin datos (antes del paso 1)
    → «Aún no hay datos», sin `NaN`.
11. (V2) Reactivar B y re-escalar con otro motivo → M3 suma 2.
- Agregar al arnés `scripts/e2e-selftest.mjs` / `pnpm test:e2e`.

### Riesgos y decisiones abiertas

- **D-02-1 (principal) — Historial de escalamientos.** El estado de
  `conversation` no permite contar escalamientos de un rango: se limpia y se
  sobrescribe.
  - **V1, sin tabla nueva**: M3 cuenta conversaciones con `handoff_at` en el
    rango *que siguen escaladas o no se reactivaron*; subcuenta y la UI lo
    marca «aproximado». M5 no existe. Solo migra el índice de `message`.
  - **V2, recomendada**: tabla append-only `conversation_handoff_event`
    (precedente `lead_stage_event`), siembra aproximada con lo abierto hoy y
    registro exacto desde el despliegue. Habilita M5 y servirá a 09 (métricas
    por vendedor) y a 05 (mismo helper). Costo: una tabla + 5 puntos de
    escritura.
- **D-02-2 — Zona horaria de los reportes.** Solo existe
  `calendar_settings.timezone` (`schema.ts:683`, agenda). Opciones: (a) fija
  `America/Mexico_City`; (b) leer `calendar_settings` si existe, si no (a)
  — recomendada para ahora, sin migración; (c) mover la zona a Ajustes → Marca
  (columna nueva en la organización/branding), lo correcto a largo plazo y útil
  también para la agenda.
- **D-02-3 — ¿Plantillas cuentan como respuesta humana?** Propuesta: sí (las
  manda un operador), pero se pueden excluir de M4 si el dueño las usa como
  campañas salientes que distorsionan los tiempos.
- **D-02-4 — Tiempos de entrega/lectura.** No hay marcas de tiempo por estado
  (`status.ts:57-60` solo cambia `status`). Si se quieren («cuánto tardan en
  leer»), hay que agregar `delivered_at`/`read_at` a `message` (otra
  migración) y llenarlos en `applyStatusUpdate`; sin histórico previo.
- **D-02-5 — Gráficas sin librería** (SVG/CSS propio, recomendado: cero
  dependencias y control del tema) vs agregar una librería (recharts ~100 KB).
- **D-02-6 — Ruta y nombre**: `/reports` «Reportes» (marco para ventas y
  anuncios, recomendado) vs `/metrics` «Métricas».
- **Riesgo**: `CREATE INDEX` sobre `message` (la tabla más grande) bloquea
  escrituras durante la migración al arrancar (no se puede `CONCURRENTLY`
  dentro de la transacción de drizzle). En una instancia con cientos de miles de
  mensajes son segundos; si preocupa, crear el índice a mano con
  `CONCURRENTLY` antes del deploy (el `IF NOT EXISTS` lo vuelve no-op).
- **Riesgo**: M4 usa `lag()` sobre todos los mensajes del rango + 24 h; con
  `message_org_created_idx` es un barrido por rango y un sort por conversación.
  Medir en T-02-09.

## Contrato 05/02-0

Fijado en el paso conjunto 05/02-0 para que **05-core**, **05-inbox**,
**02-A** y **02-B** trabajen en paralelo. Manda sobre el resto de este
documento (y es idéntico en `05-alertas-en-la-bandeja.md` y
`02-metricas-del-agente.md`). Decisiones: D-02-1 = **V2** (tabla de eventos);
D-02-2 = zona de `calendar_settings` si existe, si no `America/Mexico_City`;
D-05-1 = el contador cuenta **conversaciones**.

Código ya en el repo: `src/server/inbox/handoff.ts` (`markHandoff`), el
evento `conversation.handoff` (`src/server/events/bus.ts`, filtro en
`src/server/events/visibility.ts`, `onConversationHandoff` en
`src/components/use-events.ts`), la tabla `conversationHandoffEvent` y
`HANDOFF_REASONS` / `HANDOFF_SOURCES` en `src/lib/db/schema.ts`, el prefijo
`handoffEvent: "hoe"` (`src/lib/db/ids.ts`) y la migración
`drizzle/0017_metricas_escalamientos.sql`. Pruebas:
`tests/unit/handoff-event.test.ts`, `tests/unit/handoff-event-guard.test.ts`
y el caso nuevo de `tests/unit/events-visibility.test.ts`.

### Firma de servidor

```ts
// src/server/inbox/handoff.ts
markHandoff(input: {
  organizationId: string;
  conversationId: string;
  reason: HandoffReason;          // catálogo de conversation.handoffReason
  note?: string | null;           // se recorta con toHandoffNote (≤ 500; vacía → null)
  source: "agente" | "bot_externo" | "telefono" | "operador" | "sistema";
  pauseAi: boolean;               // true → además ai_enabled = false
  actorUserId?: string | null;    // usuario del CRM, si lo hubo
}): Promise<{ applied: true; handoffAt: Date; isTest: boolean } | { applied: false }>
```

- Transacción: `UPDATE conversation SET handoff_at, handoff_reason,
  handoff_note, updated_at[, ai_enabled = false] WHERE org AND id AND
  handoff_at IS NULL RETURNING id, is_test`. Sin fila → `{ applied: false }`,
  no escribe ni publica nada (el primer motivo gana).
- Con fila y `is_test = false`: en la MISMA transacción, `INSERT` del evento
  `opened` (misma marca de tiempo que `handoff_at`). Tras el commit:
  `publish conversation.handoff` y después `conversation.updated { id }`.
- Con `is_test = true`: solo el UPDATE (el runner del Laboratorio lo lee);
  **cero** filas de bitácora y **cero** eventos SSE.
- Llamadores hoy:

  | Origen | `reason` | `source` | `pauseAi` |
  |---|---|---|---|
  | Agente in-process (`applyHandoff`, `src/server/ai/pipeline.ts`) | `ventana` / `cliente` / `error` / `modelo` | `agente` | `false` (comportamiento previo) |
  | Respuesta manual desde el teléfono (`src/server/inbox/ingest.ts`) | `manual_reply` | `telefono` | `true` |
  | Cerebro externo (`POST /api/bot/handoff`) | `toHandoffReason(...)` | `bot_externo` | `true` |

  `operador` y `sistema` quedan reservados (p. ej. un botón «Pasar a humano»
  en la Bandeja usaría `operador` + `actorUserId`).
- Corrige la doble escritura de antes: `farewell` → `window_closed` →
  `applyHandoff("ventana")` y luego `applyHandoff("modelo")` ya no pisa el
  motivo; queda `ventana` y un solo evento.
- **No cambia**: reactivar la IA (`PATCH reactivate`,
  `src/server/inbox/queries.ts`) y `POST /api/bot/reset` siguen limpiando el
  estado de `conversation` **sin** registrar evento `closed` (recortado). Un
  re-escalamiento posterior es una transición nueva → otro `opened`.

### Evento SSE

`conversation.handoff` — `{ conversationId: string, reason: string,
handoffAt: string /* ISO-8601 */ }`. Uno por transición; nunca de `is_test`.
**Sí** se publica para `manual_reply`; el cliente decide no alertar (RF-05-03).
Visibilidad (`decideDelivery`): Propietario `deliver`; Vendedor con la MISMA
regla que `message.new` (`canSee(conversationId)`; si lanza → `drop`).
Cliente: `useEvents({ onConversationHandoff })` (firma de `useEvents`
intacta). Documentado en `specs/001-vocero-core/contracts/sse.md`.

### Tabla `conversation_handoff_event` (migración 0017)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | text PK | `hoe_…` (`newId("handoffEvent")`); sembradas: `hoe_seed_<conversation.id>` |
| `organization_id` | text NOT NULL | FK `organization` ON DELETE CASCADE |
| `conversation_id` | text NOT NULL | FK `conversation` ON DELETE CASCADE |
| `kind` | text NOT NULL | hoy solo `opened` (`closed` reservado, no se escribe) |
| `reason` | text | catálogo `HANDOFF_REASONS` |
| `note` | text | nota recortada |
| `source` | text NOT NULL | `agente \| bot_externo \| telefono \| operador \| sistema \| migracion` |
| `actor_user_id` | text | FK `user` ON DELETE SET NULL |
| `approximate` | boolean NOT NULL DEFAULT false | `true` solo en la siembra |
| `created_at` | timestamp NOT NULL DEFAULT now() | **es la hora del evento** (no existe `occurred_at`; donde este documento diga `occurred_at`, léase `created_at`) |

Índices: `hoe_org_created_idx (organization_id, created_at)`,
`hoe_org_reason_idx (organization_id, reason)`. Además
`message_org_created_idx (message.organization_id, created_at)`.

- Append-only: solo `markHandoff` inserta; nadie actualiza ni borra
  (`handoff-event-guard.test.ts`).
- Siembra re-ejecutable: una fila `opened`, `source = 'migracion'`,
  `approximate = true`, `created_at = conversation.handoff_at`, por cada
  conversación con `handoff_at` no nulo y `is_test = false`
  (`ON CONFLICT ("id") DO NOTHING`).
- Columnas `timestamp` sin zona, en UTC (como el resto del esquema).

### Regla de `manual_reply` en métricas (decisión del orquestador)

Las pausas por respuesta manual se registran como evento `opened` con
`reason = 'manual_reply'` y `source = 'telefono'`, pero las métricas las
**excluyen** de «Escalamientos por motivo» (M3) y de M5 (en M2 el
resultado no cambia: la respuesta manual ya cuenta como saliente humana,
`origin = 'manual'`, así que conviene excluirlas también del CTE `esc`
para no duplicar criterio); se muestran como
línea aparte **«Pausas por respuesta manual»** (conteo en el rango). Filtro:
`reason <> 'manual_reply'` para M3/M5 y `reason = 'manual_reply'` para la
línea aparte. Las filas `approximate = true` cuentan para totales (M3 y la
línea aparte) pero jamás para promedios de tiempo (M5).

### Qué falta (por paso)

- **05-core**: `src/lib/alerts.ts` (prefs, `shouldNotify` — `manual_reply`
  → no —, contenido, `dedupeKey` = `handoff:<conversationId>:<handoffAt>`,
  título) + tests; `events-provider.tsx` (un solo `EventSource`, D-05-4)
  conservando `useEvents(handlers)`; `favicon-badge.ts` y
  `use-unread-indicator.ts` sobre `counts` de 06.
- **05-inbox**: `use-inbox-alerts.ts` (líder entre pestañas, notificación,
  sonido, clic → `/inbox?contact=`) usando `onConversationHandoff`;
  `alerts-menu.tsx`; filtro `closing` («Ventana por cerrar») en
  `list-query.ts` + `counts.closing` + pastilla (archivos de 06: esperar a
  que 06 esté integrada); E2E `scripts/e2e-alertas.mjs`.
- **02-A (servidor)**: `src/server/reports/` (`range.ts`, `timezone.ts` con
  D-02-2, `run.ts`, `agent.ts` M1–M8 sobre `message_org_created_idx` y
  `conversation_handoff_event` con la regla de `manual_reply`),
  `src/lib/reports.ts`, `GET /api/reports/agent` solo Propietario,
  `api.md`, tests de rango/SQL/formato.
- **02-B (UI)**: ítem «Reportes» `ownerOnly`, páginas en
  `src/app/(app)/(owner)/reports/`, `src/components/reports/` (incluye la
  línea «Pausas por respuesta manual» y el aviso de datos aproximados
  anteriores a la migración 0017), E2E `scripts/e2e-metricas.mjs`.
- Ninguno necesita otra migración para esto: 0017 ya está aplicada en el
  esquema de `schema.ts` (`pnpm db:generate` sin diff).

## 3. Dependencias con otras tareas

- **00 — Roles y permisos** (antes, bloqueante): `withAuth(..., { role: "owner" })`
  (403 `forbidden`), `requireOwnerPage()` + route group `(app)/(owner)/`
  (T-00-13) y el flag `ownerOnly` del menú. 00 ya reserva la regla
  «`reports/*` = owner».
- **05 — Alertas**: comparte `src/server/inbox/handoff.ts`; quien se implemente
  primero lo crea (orden recomendado del README: 05 antes que 02, así que 02
  solo agrega la inserción del evento).
- **06 / 09**: sin dependencia dura. Coordinar el número de migración.
  Con 09 (asignación) más adelante se puede cortar M2/M4 por vendedor usando
  `actor_user_id` del registro y el operador de cada saliente (hoy `message`
  no guarda quién envió: requeriría columna `sent_by_user_id`, tarea aparte).
- **10 — Recordatorio de citas y no-shows** (después): sus métricas se agregan
  como otra pestaña/bloque sobre este marco de reportes.
- **Punto 1 (ventas) y 07 (anuncios)** (posteriores): `src/server/reports/`
  (`range.ts`, `run.ts`) y el layout con pestañas se reutilizan tal cual.
