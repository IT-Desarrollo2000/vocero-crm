# E2E — 032 Fase B: Contactos que se explican solos

Guion de comportamiento observable. Spec:
[specs/032-modulos-claros/spec.md](../../specs/032-modulos-claros/spec.md)
(US-3, decisión 3, CA-1, CA-2, CA-4). Diseño:
`specs/032-modulos-claros/diseno/Contactos.dc.html`.

Automatizado en `scripts/e2e-modulos-b.mjs` (Playwright; Propietario,
vendedora «Daniela Ortiz» y vendedor «Marco Ríos», los tres por API):

```bash
# BD aislada RECIÉN RESETEADA, app viva con .env.e2e (mocks,
# CATALOG_STORAGE=local; CHANNELS con instagram para sus filas). Lee
# DATABASE_URL para sembrar los dos contactos sin conversación.
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-b.mjs
```

Datos: chats de WhatsApp — uno de Daniela con la ventana abierta, uno de
Daniela cerrado (30 h), uno BSUID (sin teléfono) de Daniela, uno de Marco,
dos sin dueño (uno para la carrera), dos de Daniela para archivar y uno para
el fallo de archivar; un alta a mano que nunca escribió; con Instagram, un DM
de hace 3 días (de Daniela). Dos plantillas aprobadas.

Los dos estados SIN conversación que la API no puede crear — WhatsApp sin
teléfono (BSUID cuyo chat no existe) e Instagram sin chat — se insertan por
SQL en `vocero.contact`. Sin `CHANNELS` con instagram, las filas de Instagram
quedan cubiertas por `tests/unit/contact-row.test.ts`.

---

### a) API `archived` (filtro real, decisión 3)
- `archived=only` → solo archivados (aquí, Karla); `archived=exclude` y sin
  parámetro → ningún archivado; `archived=true` → todos (sentido viejo de
  «Ver archivados», lo usa `e2e-contactos-paginacion`).
- `counts.active`/`counts.archived` = los totales de cada vista; la respuesta
  trae `viewer`, `teamMode`, `businessTimezone` y por contacto su
  `conversation` (o `null`). La vendedora ve el mismo directorio.

### b) «Activos / Archivados» (CA-4)
1. Como vendedora, abre Contactos. **Esperado**: «Activos» marcado; los
   botones dicen «Activos · N» y «Archivados · M» con los números de la API;
   Karla (archivada) no está.
2. Clic en «Archivados». **Esperado**: SOLO Karla, con la insignia
   «Archivado» y el botón «Desarchivar».

### c) Archivar, Deshacer, Desarchivar
1. En Activos, «Archivar» a Luis. **Esperado**: aviso «Archivaste a Luis….
   Ya no aparece en Activos.» con «Deshacer»; Luis archivado por API, sale de
   la lista y «Archivados» sube en uno.
2. «Deshacer». **Esperado**: Luis sin archivar (API) y de vuelta en la lista.
3. En Archivados, «Desarchivar» a Karla. **Esperado**: «Desarchivaste a
   Karla…. Volvió a Activos.»; sin archivar por API; Archivados vacío dice
   «No hay contactos archivados» y qué es archivar.

### d) Acción por fila (vendedora)
| Estado | Línea de estado | Acción |
|---|---|---|
| Ventana abierta (suya) | «Te escribió … · puedes escribirle libremente … más» | «Abrir chat» → `/inbox?contact=` |
| Ventana cerrada (30 h) | «No te escribe desde hace 30 h · para retomarlo usa un mensaje aprobado» | «Retomar con plantilla» → su chat |
| Nunca escribió, con teléfono | «Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado» | «Escribir primero» |
| BSUID con chat | ventana abierta; la fila no muestra teléfono | «Abrir chat» |
| Sin teléfono, sin chat | «Sin teléfono: no hay a dónde mandarle el primer mensaje…» | ninguna (el motivo es la línea) |
| Instagram a 3 días | «Por Instagram puedes contestarle 4 días más; después, solo cuando te vuelva a escribir» | «Abrir chat» (discreto) |
| Instagram sin chat | «Por Instagram solo puedes contestarle cuando te escriba» | ninguna, sin «Escribir primero» |
| De Marco | «Lo atiende Marco Ríos · solo Marco abre su chat» | ninguna (ni enlace ni «Tomar») |
| Sin dueño | meta «nadie lo atiende todavía» | «Tomar y responder» |

### e) Propietario
- La fila de Marco trae «Abrir chat», meta «lo atiende Marco Ríos» y el estado
  de la ventana (no «solo Marco abre…»).
- La fila sin dueño trae «Abrir chat», NO «Tomar y responder» (el Propietario
  no se auto-asigna). Sin `title` ni ⓘ; a 390 px sin desborde.

### f) «Tomar y responder»
1. Vendedora: clic en «Tomar y responder» de Iris. **Esperado**: va a
   `/inbox?contact=<Iris>`; por API, el chat es de Daniela.
2. Carrera: con la página cargada, el Propietario le da el chat de Juan a
   Marco; Daniela hace clic en «Tomar y responder». **Esperado**: aviso
   «… ya tomó el chat de Juan…», sigue en `/contacts`, por API sigue siendo
   de Marco y la fila pasa a «Lo atiende Marco Ríos…».

### g) «Escribir primero» (3 pasos de 031)
1. Clic en «Escribir primero» de Ceci. **Esperado**: diálogo «Escribirle a
   Ceci por primera vez» con «Elige el mensaje» y «Revisa y envía», sin
   «Valor de {{1}}» ni el nombre técnico con idioma.
2. Sin elegir: «Enviar y abrir el chat» deshabilitado con «Elige un mensaje
   para poder enviarlo.».
3. Elige la bienvenida. **Esperado**: «Completa los espacios» con «Ceci» ya
   puesto; vaciarlo muestra «Llena el espacio 1 para poder enviarla.»; la
   vista previa dice «Hola Ceci, soy de la tienda.». A 390 px sin desborde.
4. «Enviar y abrir el chat». **Esperado**: va a `/inbox?contact=<Ceci>`; el
   wa-mock recibió la plantilla con «Ceci» a su teléfono; Ceci ya tiene
   conversación.

### h) Errores
- `GET /api/contacts` → 500: «No se pudieron cargar los contactos.» con
  «Reintentar» (sin «Sin contactos»); «Reintentar» carga la lista.
- Búsqueda sin coincidencias: «Sin resultados» (vacío ≠ error).
- `PATCH` → 500 al archivar a Mara: aviso «No se pudo archivar a Mara…: falla
  de prueba.», NO se archivó (API) y sigue en la lista; «Cerrar el aviso».

### i) Botones deshabilitados con su motivo
- Editar con el nombre vacío: «Guardar» deshabilitado + «Escribe un nombre
  para poder guardar.».
- «Nuevo contacto» vacío: «Crear contacto» deshabilitado + «Escribe su nombre
  para poder crearlo.».

### j) Sin tooltips y móvil
- En `main` de `/contacts` (lista, Archivados, diálogos abiertos): ningún
  atributo `title` ni ícono ⓘ.
- 1366 y 390 px sin scroll horizontal; ninguna fila se desborda por dentro.
