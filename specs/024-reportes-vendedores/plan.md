# 024 — Reportes: Vendedores, Equipo en Resumen y Citas por tipo/vendedor

Rama `024-reportes-vendedores` (worktree `vocero-crm-021`) desde `main`
4425578 (ya trae 011, 021b, 022 y 023). **Sin migración.** Solo Propietario.
Continúa la 021 (`specs/021-reportes-ventas-resumen/plan.md`, cuya §3 rige
rango, Laboratorio, reglas SQL y las definiciones D1/D2 de venta y asesor).

## 1. Objetivo y alcance

Paso 1 de las métricas de vendedores aprobado por el dueño (2026-10-21), más
las métricas de la agenda presencial (023):

1. **Pestaña «Vendedores»** (entre Ventas y Anuncios): una fila por vendedor
   con cartera, atención de su cartera, ventas y citas.
2. **Resumen → tabla «Equipo»** compacta para dirección.
3. **Citas** (con `AGENDA`): por tipo de cita, por vendedor y citas → ventas;
   y en Resumen una línea/KPI de citas del periodo.

Fuera (paso 2, con migración, no ahora): quién envió cada mensaje
(`message.sent_by_user_id`) y el historial de asignaciones — necesarios para
tiempo de respuesta POR VENDEDOR real y para no perder leads reasignados.
Vista «Mi desempeño» para el vendedor: después.

## 2. Hechos que condicionan el diseño (prod, 2026-10-20/21, solo lectura)

- `message` NO guarda quién lo envió; en 7 días 1 502 salientes humanos
  salieron del teléfono (`origin='manual'`, coexistencia, número compartido)
  y 626 del CRM (`operator`). Ninguno se puede atribuir a una persona.
- Asignación = solo la VIGENTE (`conversation.assigned_user_id`,
  `assigned_at`); 212 conversaciones asignadas entre 5 usuarios.
- `lead_stage_event.actor_user_id` existe (regla D2 de la 021).
- Agenda 023: `booking.assigned_user_id` (vendedor de la cita),
  `appointment_type_id` (tipo), `status` agendada/realizada/no_show/cancelada,
  `source` manual/ai, `lead_id`, `is_test`, `kind` session/block. En prod: 0
  citas, 4 tipos sembrados, sin horario configurado.

## 3. Semántica

Común: rango y zona de la 021; Laboratorio fuera (conversaciones `is_test`,
`notLabContact`, citas `is_test`); citas `kind='block'` fuera; reglas SQL
(`scoped`, `::timestamp`, sin `now()`).

**Vendedores** = TODOS los miembros de la organización (tabla `member`,
vendedores y propietarios), aunque estén en cero — dirección quiere ver
también a quien no tiene actividad. Más quien aparezca en ventas D2/citas sin
ser miembro ya (ex-miembro). Fila extra **«Sin asignar»** (cartera sin
responsable). Nombre `user.name` → email. **Invariante**: la suma de filas
(vendedores + Sin asignar) de personas/atendidas/pendientes = los totales del
Resumen para el mismo rango.

**Cartera** de un vendedor = conversaciones reales cuyo responsable VIGENTE es
él. Toda métrica de cartera dice en la UI «según la asignación actual».

### 3.1 Pestaña Vendedores — columnas por vendedor
- **Asignadas en el periodo**: conversaciones de su cartera con `assigned_at`
  en el rango.
- **Cartera activa** (foto): conversaciones de su cartera no archivadas cuyo
  lead está en etapa `open`.
- **Personas que escribieron** (de su cartera, en el rango) · **atendidas**
  (recibieron respuesta humana, `operator`/`manual`, tras su primer entrante
  del rango) · **tiempo hasta asesor** p50 (misma definición que Resumen
  `advisorFirstReply`, restringida a su cartera). La UI aclara que la
  respuesta pudo salir del teléfono compartido.
- **Pendientes** (foto): personas de su cartera cuyo último mensaje es
  entrante sin respuesta (misma regla que Resumen → Pendientes, incluye
  tarjetas 011) · **leads externos sin contactar** de su cartera.
- **Ventas** (regla D1 + D2 de la 021, la misma de Ventas → Por asesor):
  ganadas, perdidas, tasa de cierre, monto (moneda principal; otras aparte),
  ticket promedio.
- **Citas** (solo con `AGENDA`, por `booking.assigned_user_id`, cita en el
  periodo por `scheduled_at`): agendadas, realizadas, no-show, canceladas,
  asistencia = realizadas / (realizadas + no-show).
- **Embudo de su cartera** (foto): leads por etapa y monto abierto, en una
  sección aparte (tabla vendedor × etapa).
- Bloques independientes (`runBlocks`): `roster` (cartera+atención+
  pendientes), `sales` (reutiliza `byAdvisor` de Ventas — no reimplementar),
  `bookings` (si AGENDA), `funnel`.
- Fila «Sin asignar» en cartera/pendientes; «Sin asesor» de Ventas se
  muestra como tal.

### 3.2 Resumen → «Equipo»
Tabla compacta (máx. 10 filas + «Otros»): vendedor · asignadas en el periodo
· pendientes · atendidas · citas realizadas (si AGENDA) · ventas · monto.
Reutiliza los bloques de 3.1 (no SQL nuevo). Enlace «ver Vendedores» solo en
pantalla. Una viñeta en «Lectura rápida» si algún vendedor concentra
pendientes (p. ej. «Ericka tiene 18 de 33 pendientes»).

### 3.3 Citas (pestaña existente, con `AGENDA`)
Se conservan sus bloques (`offers`, `attendance`, `byReminder`). Nuevos:
- **Por tipo de cita**: agendadas, realizadas, no-show, canceladas,
  asistencia (tipos de `appointment_type`, incluidos los sin citas → 0; citas
  sin tipo → «Sin tipo»).
- **Por vendedor**: lo mismo por `booking.assigned_user_id` (+ «Sin
  vendedor»). Origen manual vs IA como columna.
- **Citas → ventas**: de las citas REALIZADAS del periodo, cuántos leads
  (distintos) están hoy en Ganado y su monto; tasa = ganados / leads con cita
  realizada. Nota: el ganado puede ser de otro periodo (foto actual del lead).
- Resumen: si AGENDA, KPI/viñeta «Citas del periodo: N agendadas · M
  realizadas · asistencia X %».

## 4. Diseño técnico
- `src/server/reports/sellers.ts` (+ DTO `SellersReportDto` en
  `src/lib/reports.ts`), ruta `GET /api/reports/sellers` (copia de
  `ads/route.ts`), matriz `permissions.ts` → owner, página
  `reports/sellers/page.tsx` (copia de `ads/page.tsx`), pestaña en
  `reports-tabs.tsx` y `reportTabLabel`, cliente `sellers-report-client.tsx`
  con `use-blocks-report.tsx` y las reglas `print:` existentes.
- Resumen: bloques `team` y `bookings` (si AGENDA), cada uno UNA consulta
  agregada (el Resumen ya corre 8 bloques con concurrencia 2 y tope de 30 s;
  no llamar al reporte completo de Vendedores). `agendaEnabled` en el DTO
  como `intakeEnabled` de la 021b.
- Rótulos honestos en Vendedores, Equipo y «Cómo se cuenta»: «según la
  asignación actual», «respuesta humana desde el CRM o el teléfono
  compartido»; en citas → ventas «ganado al momento de generar el reporte».
- Citas: bloques nuevos en `src/server/reports/bookings.ts` y su DTO; UI en
  `bookings-report-client.tsx`.
- Con `AGENDA` apagada: sin columnas/bloques de citas, superficie de Citas
  sigue en 404 (ADR-001); el resto igual.

## 5. Verificación
Gate + unit (SQL vigilado, plegado de DTOs) + consultas ejecutadas contra
Postgres real + selftest extendido en BD/puerto PROPIOS (nunca `vocero` ni
:3100): vendedores con cartera, respuestas, pendientes, ventas por actor y
por bot (D2), citas de varios tipos y estados por vendedor, una cita
realizada cuyo lead se gana; Vendedor 403/404; pestaña real; impresión +
`page.pdf()`; modos encendido y apagado (AGENDA off → sin citas). Contraste
con prod en solo lectura.
