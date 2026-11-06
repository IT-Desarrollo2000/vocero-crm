# E2E — Guía para vendedores y pantallas que se explican solas (031)

Guion de comportamiento observable. Spec:
[specs/031-guia-vendedores/spec.md](../../specs/031-guia-vendedores/spec.md).

Automatizado en `scripts/e2e-ayuda.mjs` (Playwright, dueño + vendedora):

```bash
# BD aislada RECIÉN RESETEADA (para ver «sin plantillas»), app viva con .env.e2e
# (mocks, AGENDA=on, CHANNELS con instagram). Reinicia el server antes
# (limitador de login: la pasada gasta 7 inicios de sesión).
node --env-file=.env.e2e scripts/e2e-ayuda.mjs

# Segunda pasada: server reiniciado con las banderas apagadas
AGENDA=off CHANNELS=whatsapp node --env-file=.env.e2e scripts/e2e-ayuda.mjs --off
```

Capturas de la guía (`public/ayuda/*.png`, datos ficticios, BD recién
reseteada): `node --env-file=.env.e2e scripts/ayuda-capturas.mjs
[--revisar <dir>]`.

---

## a) El link de WhatsApp llega a la guía (US-1, CA-1)

1. Navegador sin sesión → `/ayuda`.
2. **Esperado**: `/login?next=%2Fayuda`.
3. Inicia sesión como vendedora.
4. **Esperado**: la URL final es `/ayuda` y el título dice «Guía rápida de
   <nombre de la instancia>».

## b) Cualquier ruta interna vuelve tras el login

1. Sin sesión → `/inbox?contact=<id>`.
2. **Esperado**: `/login?next=…` con esa ruta; tras entrar, de vuelta en
   `/inbox?contact=<id>`.

## c) Sin redirección abierta

Para cada `next` = `//evil.com`, `https://evil.com`, `/%2F%2Fevil.com`,
`/\evil.com`: abrir `/login?next=<valor codificado>` e iniciar sesión.
**Esperado**: termina en `/inbox` del mismo origen.

## d) Menú e índice (US-2)

1. Desde la Bandeja, clic en «Ayuda» del menú (junto a «Ajustes»).
2. **Esperado**: `/ayuda`; cada tarjeta del índice apunta a un `#id` que
   existe en la página.

## e) Módulos opcionales (CA-3)

- Con `AGENDA=on` y `CHANNELS` con instagram: está el tema «El cliente quiere
  una cita» (`#citas`) y el párrafo «Instagram:» en `#archivos`.
- Con `AGENDA=off CHANNELS=whatsapp` (pasada `--off`): ni `#citas`, ni su
  tarjeta, ni ningún texto «Instagram»/«Messenger».
- 032 — `#seguimiento` está en las dos pasadas (no depende de la agenda) y,
  con la agenda apagada, no habla de citas. Con la agenda encendida va justo
  después de `#mis-chats` en el índice y cita «Mis clientes», «Sin tomar»,
  «Tomar y responder», «Retomar con plantilla», «Capturar monto» y «Lo
  atiende»; `#citas` cita «¿Cómo le fue a…», «Sí, llegó», «Tomarla», «Sin
  vendedor», «Bloquear un horario» y «todo el negocio», y ya no dice «Sin
  asignar» ni «Mostrar pruebas».

## f) Pantallas que se explican solas (US-3, CA-4) — como vendedora

- **Ventana abierta**: bajo la caja se lee «Puedes escribirle libremente … más».
  «Adjuntar» abre un `role="menu"` «¿Qué quieres mandar?» con «JPG o PNG ·
  hasta 5 MB», «Enviar ubicación» y «Compartir contacto»; Esc lo cierra y el
  foco vuelve al botón. «Documento» abre el selector de archivos con `accept`
  de documentos (pdf, docx, xlsx…, sin imágenes).
- **Ventana cerrada sin plantillas aprobadas**: «Todavía no puedes retomar este
  chat», con «Avísale al propietario…» (a la vendedora no se le ofrece crearla)
  y sin caja de texto.
- **Con una plantilla aprobada** `Hola {{1}}, te comparto la cotización de
  {{2}}.`: «Para escribirle a Rosa, usa un mensaje aprobado», pasos «Elige el
  mensaje» / «Completa los espacios»; el espacio 1 trae «Rosa»; «Enviar
  plantilla» deshabilitado con «Llena el espacio 2 para poder enviarla.» y la
  vista previa marca «falta este espacio». Al llenar el 2 se habilita; al
  enviar, el outbox del wa-mock registra `type: "template"` con los dos
  parámetros en orden.
- **IA** (agente configurado y encendido, chat con la IA): franja «La IA está
  respondiendo a Marta». Al escribir un carácter aparece «¿La pausamos
  mientras atiendes tú?»; «No, que siga» la oculta, no vuelve al seguir
  escribiendo ni al ir a otro chat y regresar sin recargar (es por chat y por
  sesión de la página; al recargar se vuelve a preguntar). No se envía nada de
  lo escrito. «Atender yo» → el chat queda asignado a la vendedora con
  `aiEnabled=false` (API) y la franja dice «Tú atiendes este chat»; «Devolver a
  la IA» → `aiEnabled=true` y vuelve la franja de la IA.
- **Buzón**: bajo las pestañas se lee «Chats que nadie ha tomado…». La fila
  trae «Tomar el chat de <nombre>»; el clic lo deja a nombre de la vendedora
  (API) sin abrir el chat, y la fila sale del Buzón.
- **Sin chat abierto**: «Hola, <nombre>» y «Esto es lo que te toca ahora:» si
  `/counts` trae pendientes (`human`, `closing` o Buzón), o «Todo al día…».
- En ninguna de esas pantallas hay un botón con `aria-label` «Ayuda: …» (los
  «?» se retiraron).

## g) Sin scroll horizontal

`/ayuda` e `/inbox` a 1366×768 y a 360 px:
`document.documentElement.scrollWidth <= innerWidth`.

## h) Texto normal

En el chat con la ventana abierta, escribir y Enter → el outbox del wa-mock
registra el `type: "text"` con ese texto.
