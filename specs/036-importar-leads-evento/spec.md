# 036 — Importar leads de evento

**Estado**: implementado en la rama `036-importar-leads-evento` (sin publicar).
**Depende de**: 011 (Leads externos: `POST /api/intake/lead`, `X-API-Key`,
bandera `LEADS_EXTERNOS`).

## Objetivo

En un evento (expo, feria, activación) los vendedores anotan prospectos en
una hoja de Excel. El administrador del sistema los importa al CRM con un
script de línea de comandos que manda cada fila al endpoint que ya existe
(`POST /api/intake/lead`) con el origen nuevo `evento`. Cada lead entra a la
Bandeja como en la 011: contacto (por teléfono), conversación, tarjeta
«Lead de evento», lead en Seguimiento.

No hay pantalla nueva y no sale ningún mensaje automático por WhatsApp: la
ventana de 24 h sigue cerrada y cada vendedor manda la plantilla a mano.

## Columnas del Excel

| Columna | Obligatoria | Va a |
|---|---|---|
| Nombre | sí | `first_name` (nombre del contacto si aún no tiene uno) |
| WhatsApp (10 dígitos) | sí | `phone` — mismas reglas que la 011 (`normalizeIntakePhone`) |
| Vendedor | no | `seller` → asignación (ver abajo) + línea «Vendedor» |
| Modelo de interés | no | `vehicle` (línea «Vehículo» + ficha si hay campo) |
| Comentarios | no | `notes` |
| Correo | no | `email` (tarjeta + ficha) |
| ¿Aceptó que le escribamos por WhatsApp? | no | `whatsapp_consent` → «Autorizó WhatsApp: Sí/No» |

Los encabezados se reconocen por alias, sin importar mayúsculas, acentos,
emojis ni signos (p. ej. «Teléfono», «Celular», «Asesor», «Notas», «E-mail»,
«Autoriza…»). La fila de encabezados puede ser cualquiera de las 5 primeras.
El WhatsApp puede venir como texto, como número o como fórmula
`HYPERLINK("https://wa.me/52…","Enviar WhatsApp")` (se leen los dígitos del
enlace). También se acepta `.csv` (UTF-8, `,` o `;`).

## Decisiones

- **Origen `evento`** en el contrato (`INTAKE_ORIGINS`) y **fuente `evento`**
  («Evento») en el contacto, solo si no tenía fuente (lo capturado manda,
  D-11-5). La columna `contact.source` no tiene CHECK: `pnpm db:generate` no
  genera migración.
- **Cabecera CONSTANTE «Lead de evento».** El Resumen (021b) reconoce el
  origen de la tarjeta en SQL por igualdad exacta con la cabecera; el nombre
  del evento viaja como línea «Evento: …» (después de Nombre y Correo), nunca
  en la cabecera.
- **Asignación por vendedor: opcional, idempotente y nunca le quita un chat a
  nadie.** `seller` se compara contra el nombre de los miembros de la
  organización, normalizado (sin acentos, minúsculas, espacios colapsados):
  nombre completo igual, o una sola palabra igual al primer nombre de
  EXACTAMENTE una persona. Nada más (sin apellidos sueltos ni parecidos). La
  conversación se asigna con `assignConversation(…, { expect: "unassigned" })`
  sin viewer: solo si está libre o ya es de esa persona.
  Resultado en la respuesta (`assignment`, solo si vino `seller`):
  `asignado` (quedó, o ya estaba, con esa persona) · `ya_asignada` (otra
  persona la tiene; no se toca) · `vendedor_no_encontrado` · `ambiguo` (el
  nombre corresponde a más de una persona) · `error` (falló la consulta; el
  lead entró igual). Es un paso accesorio: jamás tumba el lead.
- **También en el duplicado.** Si el mismo `lead_id` vuelve con `seller`, el
  endpoint responde 200 `duplicate` como siempre y además intenta asignar.
  Así funciona «corrige los nombres en el Excel y vuelve a importar». El cron
  del ERP reenvía sin `seller` → no cambia nada. Los códigos de estado no
  cambian para el ERP.
- **Sin aviso en la campana.** No se llama `notifyChatAssigned`: no hay una
  persona que asigne (`actorUserId`) y una importación de 100 filas serían 100
  avisos de golpe. El vendedor ve sus chats en «Mis chats». Sí se publica
  `conversation.updated` cuando la asignación cambia.
- **Sin mensaje automático.** No toca `lastInboundAt` ni dispara el agente
  (igual que la 011).
- **`lead_id` determinista**: UUID v5 (SHA-1, namespace fijo del script) de
  `evento normalizado|teléfono`. Re-importar el archivo no duplica tarjetas.
- **Sin pantalla nueva.** Fase 2 (si se pide): importar desde Ajustes → Leads
  externos, con lienzo en Claude Design y aprobación del dueño antes de
  codificar.
- **Logs**: solo `lead_id`, origen, últimos 4 del teléfono y el resultado de
  la asignación; nunca el nombre del vendedor ni el payload.
- **Ritmo**: el endpoint tiene un cupo GLOBAL de 120 peticiones autenticadas
  por minuto, compartido con el ERP. El script manda una a la vez con pausa de
  600 ms (~100/min) y reintenta con espera ante 429/5xx/red.
- **Reportes**: «Eventos» aparece en «Por origen» y en «Leads del formulario
  y FastApp» del Resumen solo cuando hubo leads de evento en el rango; la
  lectura rápida ya no cuenta esos leads como «por anuncio». En Ventas por
  fuente, «Evento» va antes de «Otro».

## Cómo se corre

Guía completa: [docs/importar-leads-evento.md](../../docs/importar-leads-evento.md).

```bash
# 1) Ensayo (no manda nada; escribe <archivo>.resultado.csv)
node scripts/importar-leads.mjs "Expo.xlsx" --evento "Expo Autos 2026"
# 2) Envío real
INTAKE_API_KEY=… node scripts/importar-leads.mjs "Expo.xlsx" --evento "Expo Autos 2026" --url https://crm.ejemplo.com --enviar
```

## Pruebas

- Unit: `tests/unit/importar-leads-036.test.ts` (contrato, tarjeta,
  consentimiento, vendedor, celdas/teléfono/encabezados/CSV del script),
  `tests/unit/intake-ingest.test.ts` (asignación también en el duplicado),
  `tests/unit/summary-report.test.ts` y `reports-ui-021.test.ts` (Eventos).
- E2E: sección `p)` de `scripts/e2e-leads-externos.mjs` (y el chequeo del
  importador con la bandera apagada). Guion: `tests/e2e/us-importar-leads.md`.
