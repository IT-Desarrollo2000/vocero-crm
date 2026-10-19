# Tareas de desarrollo — próxima tanda

Especificación y plan técnico de las mejoras elegidas por el dueño el
2026-10-10. Cada archivo tiene dos partes: **Especificación** (qué y para quién,
con criterios de aceptación) y **Plan técnico** (dónde se toca el código,
tareas, pruebas y riesgos).

> Estado: **todas hechas** (00, 03, 04, 09, 06, 05, 02, 10, 08) — integración
> verificada el 2026-10-12 en `feat/dev-tasks-tanda-1`: migraciones 0018/0019
> re-ejecutadas 2×, gate verde y batería E2E en vivo con los módulos encendidos
> y apagados. La numeración sigue la lista de propuestas original (por eso no
> hay 01 ni 07 activos).
>
> Prueba con modelo real (MiniMax-M3, perfil + KB de producción en BD aislada,
> set `autos`, 2026-10-13): antes de 08 score 67 / después corrida 1 50,
> corrida 2 58 con 1 `judge_failed` (el juez llenaba opcionales con `null`/`{}`
> y escribía `debió_escalar`). Tras la corrección del juez
> ([08 · Corrección tras prueba con modelo real](08-laboratorio-por-cliente.md#corrección-tras-prueba-con-modelo-real)):
> score 64, 7/7 casos juzgados, 0 `judge_failed`, 0 intentos del juez
> inválidos de 7; re-validando las 20 respuestas crudas del juez de las corridas
> anteriores: esquema viejo 7 inválidas → esquema nuevo 0.

## Decisiones ya tomadas

| Tema | Decisión |
|---|---|
| Roles | Solo dos: **Propietario** y **Vendedor** (hoy `member`). |
| Lo que el Vendedor NO ve | Reportes y métricas · Agente y Laboratorio · Configuración del pipeline (crear/renombrar/borrar etapas) · Ajustes completo. |
| Lo que el Vendedor SÍ hace | Operación diaria: Bandeja, contactos, mover leads y capturar montos, citas. |
| Bandeja con asignación | El Vendedor ve **las suyas + sin asignar**; el Propietario ve todo. |
| Atribución de anuncios (07) | Interesa, pero queda **para después**. |

## Orden recomendado

| Orden | Tarea | Por qué en este lugar |
|---|---|---|
| 1 ✅ | [00 — Roles y permisos](00-roles-y-permisos.md) — **hecha** (53329a4…99c3f67 + cierre) | Fundacional: todas las demás dependen de saber quién ve qué. También cierra huecos de seguridad actuales (un miembro puede cambiar credenciales hoy). |
| 2 ✅ | [03 — Contexto del contacto para el agente](03-contexto-del-contacto-para-el-agente.md) — **hecha** (4a08014); falta humo con modelo real antes del deploy | Bajo esfuerzo, mejora inmediata en la calidad de las respuestas. |
| 3 ✅ | [04 — El agente llena la ficha](04-el-agente-llena-la-ficha.md) — **hecha** (migración 0014); falta humo con modelo real antes del deploy | Se apoya en 03 (el agente ya ve la ficha) y alimenta métricas futuras. |
| 4 ✅ | [09 — Equipo: asignación y respuestas rápidas](09-equipo-asignacion-y-respuestas-rapidas.md) — **hecha** (migración 0015; integrada) | Define la visibilidad de la Bandeja por vendedor, que 05 y 06 necesitan. |
| 5 ✅ | [06 — Paginación de la Bandeja](06-paginacion-de-la-bandeja.md) — **hecha** (migración 0016; 4d70e5c…46aba2d; `e2e-bandeja-paginacion` 92/92) |
| 6 ✅ | [05 — Alertas en la Bandeja](05-alertas-en-la-bandeja.md) — **hecha** (contrato 05/02-0, d28e524 + 5e36e2e; `e2e-alertas` 53/53) |
| 7 ✅ | [02 — Métricas del agente](02-metricas-del-agente.md) — **hecha** (migración 0017; 7ad2edd + 4c0389b; `e2e-metricas` 83/83 ON y OFF; EXPLAIN con 100 000 mensajes: peor bloque 94 ms) |
| 8 ✅ | [10 — Recordatorio de citas y no-shows](10-recordatorio-de-citas-y-no-shows.md) — **hecha** (migración 0018; 781fa3a + db4f627; `e2e-recordatorios` 74/74 con AGENDA=on, 404 limpio con AGENDA=off) |
| 9 ✅ | [08 — Laboratorio por cliente](08-laboratorio-por-cliente.md) — **hecha** (migración 0019; d4f3803…8cbae29; `e2e-lab-personas` 86/86 + UI verificada contra el servidor real); falta la fila del Laboratorio en el «Mapa del código» de `CLAUDE.md` |

```
00 Roles ──┬── 03 Contexto ── 04 Ficha
           ├── 09 Asignación ── 06 Paginación ── 05 Alertas
           ├── 02 Métricas ── 10 Recordatorios (métricas)
           └── 08 Laboratorio
```

## Migraciones (numeración oficial)

Los archivos dicen "tentativa / siguiente libre"; **manda esta tabla**, que
sigue el orden de implementación. Si el orden cambia, se renumera aquí.

| Tarea | Migración | Contenido |
|---|---|---|
| 00 | `0013` | Índice único `member(organization_id, user_id)` (con dedupe previo) |
| 03 | — | Sin cambios de datos |
| 04 | `0014` | `agent_profile.ficha_fields`, `contact.ficha_meta`, tabla `ficha_event`, `agent_test_case.ficha_check` |
| 09 | `0015` | `conversation.assigned_user_id` + `assigned_at`, tabla `quick_reply` |
| 06 | `0016` | Solo índices de la Bandeja |
| 05 | — | Sin cambios de datos (preferencias por dispositivo) |
| 02 (+05) | `0017` | Índice `message(organization_id, created_at)` + tabla `conversation_handoff_event` (V2) con siembra — **creada en el contrato 05/02-0** |
| 10 | `0018` | `booking_reminder`, `agenda_offer_log`, ajustes de recordatorio |
| 08 | `0019` | `lab_persona`, `lab_suggestion_application`, snapshot por corrida |

Todas aditivas y re-ejecutables, probadas 2× en la BD aislada antes del deploy
(se aplican solas al arrancar el contenedor contra la BD de producción).

## Decisiones que cambian el alcance (aceptadas)

> **2026-10-12: el dueño aceptó todas las recomendaciones de esta tabla.**

Cada archivo tiene su lista completa ("Riesgos y decisiones abiertas"). Estas
son las que conviene cerrar antes de empezar; entre paréntesis, la
recomendación. Las demás pueden decidirse al implementar con la recomendación
por defecto.

| # | Decisión | Recomendación |
|---|---|---|
| D-00-1 | Al dar de baja a un vendedor, ¿se borra su usuario? | No: se borra la membresía y sus sesiones; el usuario queda para el historial y la re-alta. |
| D-00-2 | ¿Puede haber varios Propietarios? | Sí, siempre al menos uno. |
| D-09-1 | ¿Contactos y Pipeline también se restringen por asignación? | No en v1 (directorio compartido); solo la Bandeja. |
| D-09-2 | ¿Auto-asignar al escalar a humano? | No: queda "sin asignar", visible para todos; reparto por turnos después. |
| D-09-6 | ¿Un vendedor puede pasarle una conversación a otro? | No: la libera y el Propietario reasigna. |
| D-03-1 | ¿Las notas internas llegan al agente? | Sí, recortadas. |
| D-04-1 | ¿El agente llena la ficha con una acción propia o como campo extra de cualquier acción? | Campo extra: el contrato es una acción por turno y así no se pierde la respuesta al cliente. |
| D-04-4 | ¿El bot externo también respeta lo que editó un humano en la ficha? | Sí (cambia un contrato publicado; se documenta). |
| D-06-1 | Sin `limit`, ¿`/api/conversations` sigue devolviendo todo? | Sí, por compatibilidad con integraciones y pruebas. |
| D-05-1 | El contador de la pestaña/menú, ¿cuenta mensajes o conversaciones? | Conversaciones. |
| D-02-1 | Historial de escalamientos para métricas exactas | V2: tabla de eventos de escalamiento (las métricas por motivo y periodo salen exactas). |
| D-02-2 | Zona horaria de los reportes | La de la agenda si existe; si no, `America/Mexico_City`. |
| D-10-02 | Recordatorio interrumpido a medias | Se marca fallido y se reintenta a mano (nunca duplicado). |
| D-10-07 | Medir "oferta → cita": hoy las ofertas se borran en cada ronda | Tabla nueva solo de registro (`agenda_offer_log`) que nunca bloquea la oferta. |
| D-10-04 | Botones Confirmar/Cancelar en el recordatorio | Fase 2 (hoy el CRM no procesa botones). |
| D-08-01 | Personas del Laboratorio para clientes nuevos | Las instancias actuales conservan las de autos; las nuevas reciben un set neutro. |

**Nombres canónicos de los guardas de rol:** los define 00 (`withAuth(..., { role: "owner" })`, `requireOwnerPage()`, grupo de rutas `(owner)`, `useViewer()`). Donde otro archivo describa el guard de otra forma, manda 00.

## Hallazgos de paso (fuera de estas tareas)

- `e2e-bitacora-etapas` y `e2e-templates-sync` ya fallaban antes de esta tanda
  (comprobado sobre 5522e2f): no son efecto de que `templates/sync` pasara a
  ser solo de Propietario (el guion corre como Propietario).

- `cleanupOrphanRuns` (`src/instrumentation-node.ts:8-29`) marca como fallidas
  las corridas del Laboratorio en curso de **otras** réplicas al arrancar una.
  Solo importa si algún día se corre más de una réplica.
- `better-auth` instalado es 1.6.x pero `package.json` pide `^1.1.14`; fijarlo
  a `^1.6` (tarea 00).
- Las migraciones corren dentro de la transacción de drizzle, así que no hay
  `CREATE INDEX CONCURRENTLY`: crear el índice de `message` (02) bloquea
  escrituras unos segundos durante el deploy.

## Posterior

**07 — "Vino del anuncio X" + ventas por anuncio.** Requiere encender
`ATRIBUCION` (hoy apagada en producción). Se especificará cuando se lancen
campañas de Click-to-WhatsApp; reutilizará la pantalla de Reportes de 02.

**[11 — Leads externos: formulario web (futuramexico.com/contacto) y FastApp](11-leads-del-formulario-web.md)** — borrador de especificación y plan (2026-10-19, rev. 2 con el proyecto Supabase real), decisiones D-11-1…9 aprobadas (2026-10-19); en implementación. Endpoint de
entrada en el CRM con clave secreta + reenvío desde la función de Supabase del
sitio (el equipo tiene acceso). Va **después de todo lo planeado**; no afecta a
las tareas actuales. Se apoya en 00 (clave en Ajustes), 04 (ficha), 05
(alerta) y 09 (entra sin asignar).

## Cómo se implementa cada una

Por la Definición de Hecho del repo (CLAUDE.md): gate
`pnpm typecheck && pnpm lint && pnpm build && pnpm test` + self-test E2E de
comportamiento en verde contra la BD aislada (`.env.e2e`), con los módulos
opcionales encendidos y apagados cuando aplique. Una tarea = un commit (o
varios pequeños), y se marca aquí como **hecha** con su commit.
