/**
 * Matriz endpoint → política (tarea 00, RF-00-03). Fuente de verdad: la tabla
 * "Matriz de endpoints" de `dev-tasks/00-roles-y-permisos.md`.
 *
 * Clave: `"METHOD /api/<carpeta>"` — la ruta es la carpeta del `route.ts` bajo
 * `src/app/api/`, con los segmentos dinámicos tal cual (`[id]`, `[...path]`).
 *
 * `tests/unit/role-matrix.test.ts` recorre el árbol de rutas y falla si un
 * handler exportado no está aquí o si su código no aplica la guarda de su
 * política. Al agregar una ruta: clasifícala aquí en el mismo cambio.
 *
 * Sin dependencias de servidor: importable desde cliente si hiciera falta.
 */

export type RoutePolicy =
  /** `withAuth(fn, { role: "owner" })` (o `requireOwner(`): 403 al Vendedor. */
  | "owner"
  /** `withAuth(fn)`: Propietario y Vendedor por igual. */
  | "any"
  /** Cualquier rol, con respuesta filtrada por rol (y por asignación en 09). */
  | "any*"
  /** `BOT_API_KEY` (`src/server/bot/auth.ts`), sin sesión. */
  | "bot"
  /** 011: clave de leads externos (`requireIntakeKey`, `src/server/intake/auth.ts`), sin sesión. */
  | "intake"
  /** `mockGuard()` (`src/lib/dev-guard.ts`): 404 en producción. */
  | "dev"
  /** Sin sesión, con su propia defensa (firma, segmento secreto…). */
  | "public";

export const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = {
  // ── Bandeja ────────────────────────────────────────────────────────────
  "GET /api/conversations": "any*",
  // 06: contadores y detalle, siempre sobre lo visible para quien pide.
  "GET /api/conversations/counts": "any*",
  "GET /api/conversations/[id]": "any*",
  "PATCH /api/conversations/[id]": "any*",
  // 022: limpieza masiva de inactivas (archivar de una en una va por el PATCH).
  "POST /api/conversations/archive-inactive": "owner",
  // 09: tomar/liberar (ambos roles, sobre lo visible) · asignar a otro (Propietario).
  "POST /api/conversations/[id]/assign": "any*",
  "GET /api/conversations/[id]/messages": "any*",
  "POST /api/conversations/[id]/messages": "any*",
  "POST /api/conversations/[id]/messages/media": "any*",
  // 019: lote del catálogo; misma compuerta que un adjunto suelto.
  "POST /api/conversations/[id]/messages/catalog": "any*",
  "POST /api/conversations/[id]/messages/template": "any*",
  "GET /api/media/[assetId]": "any*",
  // Sesión propia (no `withAuth`): `lab.run` solo al Propietario.
  "GET /api/events": "any*",

  // ── Respuestas rápidas (09) ────────────────────────────────────────────
  // Lectura para todos (compositor con `/`); el catálogo es del Propietario.
  "GET /api/quick-replies": "any",
  "POST /api/quick-replies": "owner",
  "PATCH /api/quick-replies/[id]": "owner",
  "DELETE /api/quick-replies/[id]": "owner",

  // ── Catálogo de productos (019) ────────────────────────────────────────
  // Lectura (y descarga de fotos/fichas) para todos; escritura del Propietario.
  "GET /api/catalog": "any",
  "POST /api/catalog/categories": "owner",
  "PATCH /api/catalog/categories/[id]": "owner",
  "DELETE /api/catalog/categories/[id]": "owner",
  "POST /api/catalog/products": "owner",
  "PATCH /api/catalog/products/[id]": "owner",
  "DELETE /api/catalog/products/[id]": "owner",
  "POST /api/catalog/products/[id]/variants": "owner",
  "POST /api/catalog/products/[id]/files": "owner",
  "PATCH /api/catalog/variants/[id]": "owner",
  "DELETE /api/catalog/variants/[id]": "owner",
  "GET /api/catalog/files/[id]": "any",
  "PATCH /api/catalog/files/[id]": "owner",
  "DELETE /api/catalog/files/[id]": "owner",

  // ── Contactos ──────────────────────────────────────────────────────────
  "GET /api/contacts": "any",
  "POST /api/contacts": "any",
  "GET /api/contacts/[id]": "any",
  "PATCH /api/contacts/[id]": "any",
  "POST /api/contacts/[id]/start-conversation": "any*",
  // 04: bitácora de la ficha; hereda la visibilidad del contacto (ambos roles).
  "GET /api/contacts/[id]/ficha/history": "any",

  // ── Pipeline ───────────────────────────────────────────────────────────
  "GET /api/pipeline/board": "any",
  "PATCH /api/pipeline/leads/[id]": "any",
  "GET /api/pipeline/stages": "any",
  "POST /api/pipeline/stages": "owner",
  "PATCH /api/pipeline/stages/[id]": "owner",
  "DELETE /api/pipeline/stages/[id]": "owner",

  // ── Agenda ─────────────────────────────────────────────────────────────
  "GET /api/bookings": "any",
  "POST /api/bookings": "any",
  "PATCH /api/bookings/[id]": "any",
  // 10: reintentar un recordatorio fallido (los dos roles operan Citas).
  "POST /api/bookings/[id]/reminders/[reminderId]/retry": "any",
  "GET /api/calendar/availability": "any",
  "GET /api/calendar/settings": "owner",
  "PUT /api/calendar/settings": "owner",

  // ── Plantillas ─────────────────────────────────────────────────────────
  "GET /api/templates": "any",
  "POST /api/templates": "owner",
  "POST /api/templates/sync": "owner",

  // ── Agente y base de conocimiento ──────────────────────────────────────
  "GET /api/agent/profile": "any*",
  "PUT /api/agent/profile": "owner",
  // 04: el Vendedor recibe la definición por `GET /api/contacts/[id]`.
  "GET /api/agent/ficha-fields": "owner",
  "PUT /api/agent/ficha-fields": "owner",
  "GET /api/kb": "owner",
  "POST /api/kb": "owner",
  "PATCH /api/kb/[id]": "owner",
  "DELETE /api/kb/[id]": "owner",
  "GET /api/kb/size": "owner",

  // ── Laboratorio ────────────────────────────────────────────────────────
  "GET /api/lab/runs": "owner",
  "POST /api/lab/runs": "owner",
  "GET /api/lab/runs/[id]": "owner",
  "DELETE /api/lab/runs/[id]": "owner",
  "POST /api/lab/suggestions/apply": "owner",
  // 08: personas por organización, tendencia y "qué cambió".
  "GET /api/lab/personas": "owner",
  "POST /api/lab/personas": "owner",
  "PATCH /api/lab/personas/[id]": "owner",
  "DELETE /api/lab/personas/[id]": "owner",
  "POST /api/lab/personas/restore-defaults": "owner",
  "GET /api/lab/trends": "owner",
  "GET /api/lab/runs/[id]/diff": "owner",

  // ── Demo ───────────────────────────────────────────────────────────────
  "POST /api/seed/demo": "owner",

  // ── Ajustes ────────────────────────────────────────────────────────────
  "GET /api/settings/whatsapp": "owner",
  "PUT /api/settings/whatsapp": "owner",
  "POST /api/settings/whatsapp/test": "owner",
  "GET /api/settings/webhook": "owner",
  "GET /api/settings/instagram": "owner",
  "PUT /api/settings/instagram": "owner",
  "DELETE /api/settings/instagram": "owner",
  "GET /api/settings/messenger": "owner",
  "PUT /api/settings/messenger": "owner",
  "DELETE /api/settings/messenger": "owner",
  "GET /api/settings/capi": "owner",
  "PUT /api/settings/capi": "owner",
  "DELETE /api/settings/capi": "owner",
  // 011 — clave de leads externos (404 si LEADS_EXTERNOS está apagada).
  "GET /api/settings/intake": "owner",
  "PUT /api/settings/intake": "owner",
  "DELETE /api/settings/intake": "owner",
  "GET /api/settings/capi/events": "owner",
  "POST /api/settings/capi/events/retry": "owner",
  "POST /api/settings/capi/events/[id]/retry": "owner",
  "GET /api/settings/google": "owner",
  "PUT /api/settings/google": "owner",
  "DELETE /api/settings/google": "owner",
  "POST /api/settings/google/test": "owner",
  "GET /api/settings/zoom": "owner",
  "PUT /api/settings/zoom": "owner",
  "DELETE /api/settings/zoom": "owner",
  "POST /api/settings/zoom/test": "owner",
  // 019 — conector de almacenamiento del catálogo (404 si está apagado).
  "GET /api/settings/catalog-storage": "owner",
  "POST /api/settings/catalog-storage/test": "owner",
  "GET /api/settings/team": "owner",
  "POST /api/settings/team": "owner",
  "PATCH /api/settings/team/[memberId]": "owner",
  "DELETE /api/settings/team/[memberId]": "owner",
  "POST /api/settings/team/[memberId]/reset-password": "owner",
  // La marca la pinta también `/login`: lectura pública, escritura Propietario.
  "GET /api/settings/branding": "public",
  "PUT /api/settings/branding": "owner",
  "PUT /api/settings/branding/favicon": "owner",
  "DELETE /api/settings/branding/favicon": "owner",
  // 022: Ajustes → Bandeja (auto-archivo).
  "GET /api/settings/inbox": "owner",
  "PUT /api/settings/inbox": "owner",

  // ── Públicas ───────────────────────────────────────────────────────────
  "GET /api/branding/favicon": "public",
  // Better Auth; `/organization/*` bloqueado en su hook (RF-00-10).
  "GET /api/auth/[...all]": "public",
  "POST /api/auth/[...all]": "public",
  "GET /api/health": "public",
  "POST /api/meta/data-deletion": "public",
  // 018: la descarga Instagram (Meta) sin sesión; la defensa es el token
  // HMAC de 10 min y solo sirve salientes (`src/server/media/signed-url.ts`).
  "GET /api/media/out/[token]": "public",
  "GET /api/webhooks/wa/[webhookToken]": "public",
  "POST /api/webhooks/wa/[webhookToken]": "public",
  "GET /api/webhooks/ig/[webhookToken]": "public",
  "POST /api/webhooks/ig/[webhookToken]": "public",
  "GET /api/webhooks/fb/[webhookToken]": "public",
  "POST /api/webhooks/fb/[webhookToken]": "public",

  // ── Reportes (02) ──────────────────────────────────────────────────────
  // Solo Propietario (prefijo reservado en OWNER_ROUTE_PREFIXES).
  "GET /api/reports/agent": "owner",
  // 10: oferta → cita y asistencia (además detrás de AGENDA).
  "GET /api/reports/bookings": "owner",
  // 020 fase B: leads, ventas y monto por fuente y por anuncio.
  "GET /api/reports/ads": "owner",
  // 021: ventas por fecha de cierre (D1/D2) y resumen para dirección.
  "GET /api/reports/sales": "owner",
  "GET /api/reports/summary": "owner",

  // ── Cerebro externo (BOT_API_KEY) ──────────────────────────────────────
  "GET /api/bot/availability": "bot",
  "POST /api/bot/bookings": "bot",
  "PATCH /api/bot/bookings": "bot",
  "GET /api/bot/context": "bot",
  "PUT /api/bot/ficha": "bot",
  "POST /api/bot/handoff": "bot",
  "GET /api/bot/media/[mediaId]": "bot",
  "POST /api/bot/messages": "bot",
  "GET /api/bot/profile": "bot",
  "POST /api/bot/reset": "bot",
  "POST /api/bot/typing": "bot",

  // ── Leads externos (011: clave del ERP; 404 sin LEADS_EXTERNOS) ────────
  "POST /api/intake/lead": "intake",

  // ── Mocks del entorno de pruebas (404 en producción) ───────────────────
  "POST /api/dev/ai-mock/chat/completions": "dev",
  "POST /api/dev/ai-mock/v1/chat/completions": "dev",
  // 10: una vuelta del ticker de recordatorios con reloj simulado.
  "POST /api/dev/reminders/tick": "dev",
  // 018: una vuelta de la purga de adjuntos (caché de 30 días), reloj adelantable.
  "POST /api/dev/media/purge": "dev",
  // 022: una vuelta del auto-archivo (respeta el interruptor), reloj adelantable.
  "POST /api/dev/inbox/auto-archive": "dev",
  // 020: ¿se guardó el ctwa_clid? (la API pública solo dice si existe con la bandera).
  "GET /api/dev/attribution": "dev",
  // 10: falla conmutable de los envíos de WhatsApp del mock.
  "GET /api/dev/wa-mock/fail-sends": "dev",
  "POST /api/dev/wa-mock/fail-sends": "dev",
  // 019 fase B: el mock deja de reconocer un id subido (prueba de re-subida).
  "POST /api/dev/wa-mock/invalidate-media": "dev",
  "GET /api/dev/google-mock/[...path]": "dev",
  "POST /api/dev/google-mock/[...path]": "dev",
  "PATCH /api/dev/google-mock/[...path]": "dev",
  "DELETE /api/dev/google-mock/[...path]": "dev",
  "GET /api/dev/wa-mock/capi-events": "dev",
  "DELETE /api/dev/wa-mock/capi-events": "dev",
  "POST /api/dev/wa-mock/channel-inbound": "dev",
  "POST /api/dev/wa-mock/channel-token": "dev",
  "POST /api/dev/wa-mock/echo": "dev",
  "GET /api/dev/wa-mock/graph/[...path]": "dev",
  "POST /api/dev/wa-mock/graph/[...path]": "dev",
  "DELETE /api/dev/wa-mock/graph/[...path]": "dev",
  "POST /api/dev/wa-mock/inbound": "dev",
  "GET /api/dev/wa-mock/media-file/[id]": "dev",
  "GET /api/dev/wa-mock/cdn/[id]": "dev",
  "GET /api/dev/wa-mock/outbox": "dev",
  "DELETE /api/dev/wa-mock/outbox": "dev",
  "POST /api/dev/wa-mock/status": "dev",
  "POST /api/dev/wa-mock/template-status": "dev",
  "GET /api/dev/zoom-mock/[...path]": "dev",
  "POST /api/dev/zoom-mock/[...path]": "dev",
  "PATCH /api/dev/zoom-mock/[...path]": "dev",
  "DELETE /api/dev/zoom-mock/[...path]": "dev",
};

/**
 * Regla reservada (tarea 02): todo handler bajo estos prefijos es del
 * Propietario. El test de la matriz la vigila cuando esas rutas existan.
 */
export const OWNER_ROUTE_PREFIXES: readonly string[] = [
  "/api/reports",
  "/api/metrics",
];
