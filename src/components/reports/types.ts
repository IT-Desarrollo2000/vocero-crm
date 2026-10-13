/**
 * 02 — DTO de `GET /api/reports/agent` para la pantalla Reportes → Agente.
 *
 * Integrado: la fuente canónica es `src/lib/reports.ts` (02-A, compartida
 * cliente/servidor, solo tipos y utilidades puras). Este archivo queda como
 * re-export para que los componentes de `src/components/reports/` no cambien
 * sus imports. `exactSince` no lo envía el servidor hoy (opcional); el
 * `error` de un bloque caído es `"timeout" | "unavailable"` (`ReportBlockError`).
 */

export * from "@/lib/reports";
