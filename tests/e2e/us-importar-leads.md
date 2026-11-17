# E2E — Importar leads de evento (036)

Guion de comportamiento observable. Automatizado en la sección `p)` de
`scripts/e2e-leads-externos.mjs` (y, con la bandera apagada, el chequeo del
importador en su mitad `off`). Mismo arranque que
[us-leads-externos.md](us-leads-externos.md): BD aislada, `CATALOG_STORAGE=local`
y `LEADS_EXTERNOS` con el mismo valor en el server y en el guion.

## US1 — Un lead de evento entra a la Bandeja

1. `POST /api/intake/lead` con `origin: "evento"`, `event`, `seller`,
   `whatsapp_consent: "x"` → **201** con `assignment: "asignado"`.
2. La tarjeta abre con **«Lead de evento»** (sin el nombre del evento) y trae
   «Evento: …» después de Nombre/Correo, «Vendedor», «Autorizó WhatsApp: Sí».
3. La conversación queda asignada a esa persona; la ventana sigue cerrada
   (compositor en plantilla) y el agente no escribe.
4. La fuente del contacto es «Evento» si no tenía; si ya tenía otra (p. ej.
   «Sitio web»), no cambia.

## US2 — El vendedor del Excel

1. Nombre completo con otras mayúsculas/espacios → asignado.
2. Solo el primer nombre, con o sin acentos, y una sola persona lo tiene →
   asignado.
3. Nadie con ese nombre → `vendedor_no_encontrado`, sin asignar.
4. Primer nombre de dos personas → `ambiguo`, sin asignar.
5. La conversación ya es de otra persona → `ya_asignada` y NO se le quita.

## US3 — Corregir y volver a importar

1. El mismo `lead_id` con el vendedor corregido → **200** `duplicate` +
   `assignment: "asignado"`, sin otra tarjeta.
2. El mismo `lead_id` sin `seller` (como el cron del ERP) → 200 sin
   `assignment`.

## US4 — El script con un Excel real

Con un `.xlsx` que mezcla WhatsApp en texto, número y fórmula
`HYPERLINK("https://wa.me/521…","Enviar WhatsApp")`, una fila con teléfono
inválido, una repetida y una columna desconocida:

1. Ensayo (sin `--enviar`): 3 válidos, 1 inválido, 1 repetido, la columna
   desconocida reportada; escribe `<archivo>.resultado.csv`; en el CRM no
   aparece nada; en la consola nunca la clave ni un teléfono completo.
2. `--enviar`: 3 nuevos con su tarjeta; la fila con vendedor queda asignada;
   «Vendedores sin coincidencia» lista el que no existe.
3. Volver a correrlo (aunque el evento se escriba con otras mayúsculas) → 0
   nuevos, 3 duplicados, una sola tarjeta por contacto.
4. Con una clave mala se detiene en la primera fila (401) y sale ≠ 0.
5. Con la bandera apagada se detiene (404, «LEADS_EXTERNOS») y sale ≠ 0.

## US5 — Importar desde el CRM (036 fase 2)

Automatizado en `scripts/e2e-importar-contactos.mjs` (con la app levantada con
`LEADS_EXTERNOS` encendida y apagada: la pantalla no depende de la bandera) y,
por API, en la sección «036 fase 2» de `scripts/e2e-selftest.mjs`. Capturas en
`specs/036-importar-leads-evento/capturas/`.

1. Propietario: en Contactos, «Importar desde Excel» junto a «Nuevo
   contacto» → `/contacts/importar` (paso 1 «Subir la lista»).
2. «Descargar plantilla (.xlsx)»: hojas Leads / Instrucciones / Equipo; los 7
   encabezados en orden; WhatsApp como texto con validación de 10; la lista de
   Vendedor apunta a la hoja Equipo con los nombres del equipo de hoy; Sí/No.
3. Un CSV sin columnas de nombre/WhatsApp → error en línea que dice cuáles
   necesita; un .txt → «Solo se leen archivos de Excel (.xlsx) o .csv.»;
   «Revisar la lista» deshabilitado.
4. Fixture (texto, número, HYPERLINK wa.me/521…, uno con 9 dígitos, uno
   repetido, vendedor desconocido, vendedor ambiguo, uno que ya es contacto,
   uno sin vendedor): «9 renglones · columnas: …»; Revisar: 7 listos («1 de
   ellos ya está en tus contactos»), 1 con problema, 1 repetido; líneas de
   vendedor (con nombre / nadie se llama así / más de una persona / sin
   vendedor anotado); filtros Con problema · Repetidos · Todos. **Cero
   escrituras** (contactos, mensajes, conversaciones, leads contados en la BD).
5. «Importar 7 contactos» → «Listo: 7 contactos de «…»»: 6 nuevos, 1 ya
   estaba, 3 asignados, 4 en el Buzón; tarjeta «Lead de evento» con el
   `lead_id` determinista del script; los asignados son de su vendedor y la
   vendedora los ve en «Mis chats»; el resultado .xlsx trae los 9 renglones.
6. La misma lista otra vez, con un lote que falla → «Se detuvo en 0 de 7…» y
   «Reintentar lo que falta» → Listo con 0 nuevos y «7 ya se habían
   importado»; ninguna tarjeta nueva.
7. Vendedora: sin el botón; `/contacts/importar` → 404; las 4 rutas de
   `/api/contacts/import` → 403; sin sesión → 401.
