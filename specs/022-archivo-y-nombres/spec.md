# 022 — Archivar conversaciones inactivas y renombrar contactos

**Carril**: ciclo completo (Principio VI). Toca modelo de datos (migración
0023), la Bandeja (vistas, contadores, espejo cliente), la ingesta y el envío,
un ticker nuevo y una página de Ajustes. Núcleo: sin terceros ni bandera de
despliegue (el auto-archivo es un ajuste por organización, apagado).

## Problema

1. **Bandeja saturada.** Muchas conversaciones llevan días sin actividad de
   ningún lado (fuera de ventana de 24 h en WhatsApp / 7 días *human agent* en
   IG y Messenger) o nunca se atendieron. No se retoman, pero siguen arriba
   de las activas. No hay forma de sacarlas de la vista.
2. **Nombres tipo nickname.** El nombre del contacto es el de perfil del
   canal ("Dios es amor"). El backend ya permite renombrar (PATCH
   `/api/contacts/[id]`, rol Vendedor) y la página Contactos tiene el diálogo,
   pero en la Bandeja —donde trabaja ventas— el nombre es de solo lectura, y
   al renombrar se pierde el nickname original (ya no se puede buscar por él).

## Decisiones del dueño (17/19-oct-2026)

1. Umbral de inactividad por defecto: **14 días**.
2. Auto-archivo **apagado por defecto**; lo enciende el Propietario.
3. Vendedor y Propietario archivan **de una en una**; la limpieza **masiva**
   es solo del Propietario.
4. Se **conserva el nombre de perfil original** (`profile_name`) aparte del
   nombre que pone el equipo.
5. Archivar **nunca borra**: historial, reportes, atribución y dedupe intactos.

## Historias

### US-A1 — Archivar / desarchivar una conversación (Vendedor y Propietario)
- Botón **Archivar** en la cabecera del hilo y acción rápida en la fila de la
  lista (icono al pasar el cursor / enfocar).
- La conversación sale de Todas, No leídas, Mías, Requiere humano y de los
  contadores; aparece en la vista nueva **Archivadas** (contador propio).
- Abierta y archivada, el hilo muestra un aviso "Conversación archivada" con
  **Desarchivar**. Se puede seguir escribiendo; enviar la desarchiva.
- El Vendedor solo archiva lo que ve (visibilidad por asignación).

### US-A2 — Volver sola a la Bandeja
- Un mensaje **entrante** (WhatsApp, Instagram, Messenger, anuncio sin
  mensaje de la 020) desarchiva la conversación.
- Un **saliente** exitoso (operador, agente IA, bot API, plantilla,
  catálogo, eco del teléfono) también la desarchiva. Un envío fallido no.

### US-A3 — Búsqueda
- Con texto en el buscador, los resultados incluyen archivadas, con la
  etiqueta **Archivada** en la fila.

### US-A4 — Limpiar inactivas (solo Propietario)
- En **Ajustes → Bandeja**: "Archivar conversaciones sin actividad desde hace
  más de [N] días" (N por defecto 14, rango 1–365). Antes de confirmar muestra
  **cuántas** se archivarían. Aplica las excepciones de US-A5.

### US-A5 — Auto-archivo (Propietario)
- En **Ajustes → Bandeja**: interruptor "Archivar automáticamente" (apagado)
  + días (14). Un proceso en segundo plano archiva periódicamente.
- **Inactiva** = `coalesce(last_message_at, created_at)` anterior a N días.
- **Excepciones** (auto y masiva): cita futura `agendada` ligada a la
  conversación o al contacto; lead en una etapa marcada **"No archivar"**
  (nuevo ajuste por etapa en Seguimiento, solo Propietario); traspaso a humano
  (`handoff_at`) dentro de los últimos N días.
- Ya archivadas y de prueba (`is_test`) nunca se tocan.

### US-B1 — Renombrar desde la Bandeja
- En el panel **Detalles**, el nombre es editable en línea (lápiz → campo,
  Enter guarda, Esc cancela, 1–120 caracteres, error visible sin perder lo
  escrito). La fila, la cabecera y otros usuarios conectados se actualizan
  sin recargar (SSE).

### US-B2 — Conservar el nickname
- `contact.profile_name` guarda el nombre de perfil del canal. WhatsApp lo
  manda en cada mensaje → se actualiza en cada entrante. En IG/Messenger
  (Meta) se captura cuando ya se consulta a Graph (alta / nombre de relleno),
  sin llamadas extra por mensaje; Zernio lo trae en el payload.
- Si difiere del nombre, se muestra en gris bajo el nombre: *WhatsApp:
  "Dios es amor"* (panel de la Bandeja y página Contactos).
- La búsqueda encuentra por nombre **o** por nombre de perfil.
- Renombrar nunca se revierte por un entrante (comportamiento actual).

## Fuera de alcance
- Borrado de conversaciones o contactos.
- Deshacer en lote la limpieza/auto-archivo (queda `archived_reason` para
  hacerlo después).
- Que el agente IA proponga el nombre real.
- Archivado de contacto (`contact.archived_at`, página Contactos) — sin cambios.

## Criterios de aceptación
- E2E por API y por UI (Playwright) en verde con los mocks, incluido el
  camino infeliz: nombre vacío/largo → 400 sin cambios; Vendedor no ve /
  no puede limpiar ni tocar ajustes (403/404); auto-archivo apagado no
  archiva nada; excepciones respetadas; entrante desarchiva.
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
