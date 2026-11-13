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
