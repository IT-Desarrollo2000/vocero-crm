# E2E — 032 Fase A: Seguimiento y Citas que se explican solos

Guion de comportamiento observable. Spec:
[specs/032-modulos-claros/spec.md](../../specs/032-modulos-claros/spec.md)
(US-1, US-2, CA-1 a CA-3). Diseño: `specs/032-modulos-claros/diseno/Main.dc.html`
y `Citas.dc.html`.

Automatizado en `scripts/e2e-modulos-a.mjs` (Playwright; Propietario,
vendedora «Daniela Ortiz» y vendedor «Marco Ríos», los tres por API):

```bash
# BD aislada RECIÉN RESETEADA, app viva con .env.e2e (mocks, AGENDA=on,
# CATALOG_STORAGE=local). Lee DATABASE_URL para dejar una cita en el pasado.
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-a.mjs
```

Datos: siete chats de WhatsApp — uno de Daniela esperando respuesta, uno sin
dueño, uno de Marco, uno de Daniela con la ventana cerrada (30 h), uno sin
dueño para la carrera y dos de Daniela ya contestados.

---

## Seguimiento (`/pipeline`)

### a) Filtro por rol, recordado y con conteos
1. Como vendedora, abre Seguimiento. **Esperado**: «Mis clientes» marcado;
   los tres botones dicen «Mis clientes · 4», «Sin tomar · 2», «Todos · 7».
   La tarjeta de Marco no se ve.
2. «Sin tomar» deja solo los chats sin dueño.
3. Elige «Todos» y recarga. **Esperado**: sigue en «Todos».
4. Como Propietario. **Esperado**: arranca en «Todos»; ve «Gestionar etapas».

### b) Tarjeta de otro vendedor
- Vendedora: la tarjeta dice «Lo atiende Marco Ríos» y «Solo Marco abre este
  chat.», y NO tiene «Abrir chat» (ningún enlace).
- Propietario: la misma tarjeta sí trae «Abrir chat».
- La suya dice «Tú lo atiendes» y «Espera respuesta · …».

### c) «Tomar y responder»
1. En «Sin tomar», clic en «Tomar y responder». **Esperado**: va a
   `/inbox?contact=<id>` y por API el chat queda a nombre de la vendedora.
2. Con el tablero ya cargado, el Propietario le da otro chat sin dueño a Marco;
   la vendedora hace clic en su «Tomar y responder». **Esperado**: aviso «Otro
   vendedor ya tomó el chat de …», se queda en Seguimiento y por API sigue
   siendo de Marco.

### d) Ventana cerrada
La tarjeta del chat de hace 30 h dice «Su chat se cerró…» y trae «Retomar con
plantilla» → `/inbox?contact=<id>`.

### e) Ganar sin monto y «lo que te toca»
1. Clic en una tarjeta suya → panel del trato → «Mover a Cliente».
   **Esperado**: por API queda en la etapa ganada con `amountCents` null (se
   permite ganar sin monto).
2. La tarjeta dice «Compró, pero falta cuánto.» y trae «Capturar monto».
3. La franja muestra «Venta sin monto»; su acceso abre «Monto y prioridad».
   El acceso «… clientes tuyos esperan tu respuesta» lleva a `/inbox`.

### f) Columnas
«Perdido» vacía: «Aquí van los que decidieron no comprar.»; una etapa abierta
vacía: «Nadie en esta etapa todavía.»; «Cliente» con «ya compró».

### g) Errores visibles
1. `GET /api/pipeline/board` responde 500 en la primera carga. **Esperado**:
   «No se pudo cargar el tablero.» + «Reintentar»; al quitar la falla,
   «Reintentar» pinta el tablero.
2. `PATCH /api/pipeline/leads/*` responde 500 al mover desde el panel.
   **Esperado**: aviso «No se pudo mover a <cliente> a <etapa>; volvió a su
   lugar…» y por API sigue en su etapa.

### h) En vivo
Con la pestaña abierta (SSE encendido), entra un mensaje por wa-mock a un chat
ya contestado. **Esperado**: sin recargar, su tarjeta dice «Espera respuesta».

## Citas (`/bookings`)

### i) «¿Cómo le fue a…?»
Una cita de la vendedora de AYER sin resultado (creada a futuro y retrocedida
por SQL). **Esperado**: «¿Cómo le fue a <cliente>?» con «Sí, llegó», «No
asistió» y «Reprogramar». «Sí, llegó» → por API `realizada` y la pregunta se va.
Arriba: «Horarios en hora de Ciudad de México.»

### j) «Tomarla» y la carrera
1. «2 citas sin vendedor» → «Tomarla» (la primera). **Esperado**: por API
   asignada a la vendedora; aviso «Tomaste la cita de …».
2. Dos `PATCH {action:"take"}` simultáneos (Daniela y Marco) sobre otra cita
   sin vendedor. **Esperado**: uno 200 y otro 409 `already_taken`; la cita es
   de quien ganó.

### k) Lo del Propietario y el bloqueo
- Vendedora: no ve «Mostrar citas del Laboratorio»; el filtro dice «Mías ·
  Sin vendedor · Todas». Propietario: sí ve el interruptor.
- «Bloquear un horario · cierra la agenda de todo el negocio…»: la vendedora
  bloquea 30 min pasado mañana. **Esperado**: «Listo: bloqueaste …».

## Ambos

### l) Sin tooltips y a 390 px
- En `/pipeline` y `/bookings` (semana y día), como vendedora y como
  Propietario: ningún elemento con atributo `title` y ningún ícono ⓘ.
- A 390×844: `document.documentElement.scrollWidth <= innerWidth`.
