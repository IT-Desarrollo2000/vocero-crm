# 036 — Importar leads de evento

**Estado**: fase 1 (script) y fase 2 (pantalla en el CRM) implementadas en la
rama `036-importar-leads-evento` (sin publicar).
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
- **Fase 1 sin pantalla.** La pantalla llegó en la fase 2 (abajo), en
  Contactos y no en Ajustes → Leads externos.
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

## Fase 2 — Importar desde el CRM

**Diseño aprobado** (Claude Design): https://claude.ai/artifact/J3FJ7zmwDUXkwtUQSzYg77
· copias en [diseno/](diseno/): `Entrada`, `Main` (Subir la lista),
`Revisar`, `Resultado` (`.dc.html`). Capturas de la app en
[capturas/](capturas/).

Contactos → «Importar desde Excel» → `/contacts/importar`: **1 Subir la lista**
(plantilla + nombre del evento + archivo) → **2 Revisar** (no escribe nada) →
**3 Listo** (números reales y resultado por renglón).

### Decisiones

- **Solo Propietario.** El botón solo se pinta para el Propietario; la página
  vive en `(app)/(owner)/contacts/importar` (`requireOwnerPage()`: 404 al
  Vendedor) y las 4 rutas son `withAuth(…, { role: "owner" })` (prefijo
  `/api/contacts/import` reservado en `OWNER_ROUTE_PREFIXES`).
- **Sin bandera.** Es CRM base: no pasa por `requireIntakeKey` (ni la bandera
  `LEADS_EXTERNOS`, ni la clave del ERP, ni su cupo global). Funciona con la
  bandera apagada (probado en E2E con las dos).
- **Mismo camino que el script.** Un solo lector
  (`src/lib/contact-import/core.mjs` + tipos en `core.d.mts`; `.mjs` para que
  el script lo use con `node` a secas): encabezados por alias, celdas,
  HYPERLINK wa.me, CSV, `planImportRows`, `leadPayload` y el `lead_id` v5.
  El servidor normaliza con `normalizeIntakePhone`; el script conserva su copia
  (un test las compara). Cada renglón va por `intakeLeadSchema` +
  `ingestExternalLead` → mismo `lead_id`: lo importado por la pantalla y por
  el script se reconoce como «ya importado» en los dos sentidos.
- **Vista previa sin escrituras.** `POST /api/contacts/import/preview`
  (multipart): 5 MB, 2,000 renglones con datos (los renglones con formato pero
  vacíos no cuentan: la plantilla trae 2,000), primera hoja con datos, tipo por
  firma (zip) y no solo por extensión. «Ya estaban»: UNA consulta por
  `wa_identity` o `phone` en el canal whatsapp (la misma llave que
  `getOrCreateContactByIdentity`), archivados incluidos.
- **Vendedores:** una línea por texto distinto (normalizado como al asignar)
  con `matchSeller`: persona / nadie se llama así / más de una persona; más
  «Sin vendedor anotado». Solo cuenta renglones listos.
- **Lotes de 50**, en orden, desde la pantalla (`POST /api/contacts/import`
  acepta hasta 100). Cada renglón en su try/catch: un fallo es `error` de ese
  renglón. Si falla un lote entero, «Reintentar lo que falta» (idempotente).
  Tras cada lote, una consulta dice con quién quedó cada chat que no se asignó
  a su vendedor: «ya tenía vendedor» o «Buzón».
- **Plantilla** (`GET /api/contacts/import/template`, exceljs): Leads (7
  columnas, encabezado congelado, WhatsApp `@` + validación de 10 en 2,000
  renglones, Vendedor = lista por RANGO a la hoja «Equipo» — la lista en línea
  topa en 255 caracteres —, Sí/No), Instrucciones, Equipo. Escribir otro
  vendedor da aviso, no bloqueo (ese chat queda en el Buzón).
- **Resultado** (`POST /api/contacts/import/result`): lo arma el servidor
  para que exceljs no viaje al navegador (`serverExternalPackages`); exceljs
  pasó a `dependencies`.
- **Ayuda:** tema «Me llegaron chats de un evento» (`leads-de-evento`) para
  vendedores, sin captura. La guía del Propietario es
  [docs/importar-leads-evento.md](../../docs/importar-leads-evento.md).

### Diferencias con el diseño aprobado

- «Ver los chats del evento en la Bandeja» → **«Ver en la Bandeja»** (`/inbox`):
  la Bandeja no filtra por evento y no se agregó ese filtro (aprobado).
- **Estado de importación** (no estaba en el lienzo): el botón dice
  «Importando 50 de 117…» deshabilitado; si un lote falla, aviso en rojo
  «Se detuvo en N de M: … Lo que ya entró no se duplica al reintentar.» y el
  botón cambia a «Reintentar lo que falta».
- **Errores de la vista previa** en el mismo renglón del archivo elegido
  (rojo, «Elegir otro archivo»); mientras lee, «Leyendo la lista…».
- Tarjetas en 0 de Revisar en gris con su frase («Todos traen nombre y un
  WhatsApp válido.», «Ningún WhatsApp se repite.»); las píldoras de filtro en
  0 se ocultan (Todos siempre). Renglones de 50 en 50 con «Mostrar más».
- Línea «coincide con más de una persona del equipo» para el vendedor ambiguo.
- «Lo que sigue» solo con las líneas que aplican; además «N ya tenían
  vendedor: se quedaron con esa persona», «N ya se habían importado con este
  evento: no se duplicó nada» y los renglones con error.
- Colores con los tokens de la app (acento de la marca), no los hex del
  lienzo.

### Pruebas (fase 2)

- Unit: `tests/unit/importar-contactos-036b.test.ts` (lector, vista previa,
  archivo, plantilla y resultado re-leídos con exceljs, contrato del lote,
  `importRows` = cuerpo del script) · `role-matrix.test.ts` (rutas y página).
- E2E: `scripts/e2e-importar-contactos.mjs` (guion US5 de
  [tests/e2e/us-importar-leads.md](../../tests/e2e/us-importar-leads.md)) y la
  sección «036 fase 2» de `scripts/e2e-selftest.mjs`.
