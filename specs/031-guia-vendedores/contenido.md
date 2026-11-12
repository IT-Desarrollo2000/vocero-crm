# 031 — Contenido de la guía (fuente para `src/lib/help/topics.ts`)

Trato **tú**. `{negocio}` = `branding.name`. Las etiquetas entre «» son las
que aparecen en pantalla: si una cambia en la UI, cámbiala aquí y en
`topics.ts`. Las capturas (`captura`) viven en `public/ayuda/`.

Rebanada 4 (5-nov): la pantalla de chats ya no tiene botones «?»; se explica
sola (diseño aprobado). Esta guía cita esa pantalla nueva. Cada tema lleva
antetítulo, título (la situación), una línea para el índice y una intro;
luego pasos, captura y «¿Y si…?».

---

## Encabezado

**Guía rápida de {negocio}**
Todo para atender a tus clientes por WhatsApp sin complicarte. Elige lo que
te está pasando y sigue los pasos.

---

## 1. `plantillas` — Retomar un chat · «Ya no puedo escribirle al cliente»

Índice: Pasaron 24 horas: retómalo con una plantilla.

**Intro:** WhatsApp solo deja escribir libremente durante las 24 horas
siguientes al último mensaje del cliente. Después, la única forma de
escribirle es con una **plantilla**: un mensaje que WhatsApp ya aprobó. No es
una falla: es una regla de WhatsApp.

1. Abre el chat. Donde estaba la caja de texto verás «Para escribirle a …,
   usa un mensaje aprobado».
2. En «Elige el mensaje» marca el que mejor quede (por ejemplo, un
   seguimiento de cotización).
3. En «Completa los espacios» llena cada espacio; abajo de cada uno ves en
   qué parte del mensaje va. Si el mensaje empieza con un saludo, el nombre
   del cliente ya viene puesto: revisa que esté bien.
4. Revisa en «Revisa y envía» cómo le va a llegar y haz clic en «Enviar
   plantilla».
5. *(033)* En lugar del formulario verás «Plantilla enviada a … · hora» con
   cómo va: «Enviada», «Entregada» o «Leída». Ya salió: no hace falta
   enviarla otra vez. Cuando te conteste, ya puedes escribir normal.

**¿Y si…?**
- *(033)* **Aparece «Ya le enviaste este mensaje a … hace … min.»:** ese mismo
  mensaje acaba de salir; si lo mandas otra vez, le llegará repetido. Usa
  «Enviar de todos modos» solo si de verdad quieres repetirlo.
- *(033)* **Dice «La plantilla de las … no le llegó a …»:** WhatsApp no la
  aceptó y ahí mismo dice por qué. Revísala abajo y vuelve a enviarla.
- *(033)* **Quieres mandarle una distinta:** haz clic en «Enviar otra
  plantilla».
- **No aparece ningún mensaje para elegir:** verás «Todavía no puedes
  retomar este chat». Tu equipo aún no tiene plantillas; pídele al
  propietario que cree una (WhatsApp tarda desde unos minutos hasta un día
  en aprobarla).
- **No se activa «Enviar plantilla»:** te falta llenar un espacio; abajo del
  botón dice cuál («Llena el espacio … para poder enviarla.»).
- **Los botones de «Pegar texto de plantilla» (con la ventana abierta):**
  esos solo pegan el texto en tu mensaje para ahorrarte escribir; no son
  plantillas oficiales.

Captura: `plantilla-enviar.png`

---

## 2. `respuestas-rapidas` — Ahorrar tiempo · «Siempre escribo lo mismo»

Índice: Usa respuestas rápidas con la diagonal /.

**Intro:** las **respuestas rápidas** son mensajes guardados (horario,
ubicación, formas de pago…) que pegas en un segundo.

1. Arriba de la caja de texto verás «Respuestas rápidas» con las primeras
   como botones, por ejemplo «/horario · Horario». Un clic y el texto queda
   en tu mensaje.
2. Para ver todas, escribe **/** (la diagonal) en la caja y sigue escribiendo
   para buscar, por ejemplo `/horario`.
3. Elige con las flechas ↑ ↓ y presiona **Enter** (o haz clic).
4. El texto queda en tu mensaje: **revísalo o cámbialo** y luego envíalo. No
   se manda solo.

**Se llenan solas:** si la respuesta dice `{{nombre}}`, se cambia por el
nombre del cliente; `{{vendedor}}` por tu nombre; `{{negocio}}` por
{negocio}.

**Crear la tuya** *(si el propietario lo permite)*: escribe tu mensaje y haz
clic en «Guardar como respuesta rápida» debajo de la caja, o elige
«+ Nueva respuesta rápida» al final de la lista. Ponle un atajo corto
(por ejemplo `pagos`). Queda para todo el equipo. Puedes editar o borrar las
tuyas en «Ajustes» → «Respuestas rápidas».

**¿Y si…?** No ves «Guardar como respuesta rápida»: el propietario tiene
apagada esa opción; pídele que agregue la respuesta.

Captura: `respuestas-rapidas.png`

---

## 3. `archivos` — Mandar archivos · «Quiero mandar un documento o foto»

Índice: Qué se puede mandar y qué hacer si no se deja.

**Intro:** desde el chat puedes mandar fotos, documentos, video y audio.
Antes de elegir el archivo, la pantalla te dice qué formatos acepta el canal
y hasta cuánto pesa cada tipo.

1. Haz clic en «Adjuntar», junto a la caja de texto. Se abre «¿Qué quieres
   mandar?» con cada tipo («Foto», «Documento», «Video», «Audio»), sus
   formatos y su tamaño máximo.
2. Elige el tipo y luego el archivo en tu computadora.
3. Lo que escribas en la caja se envía como **pie** del archivo (es
   opcional). Envía.

Nota (WhatsApp): en el mismo menú están «Enviar ubicación» y «Compartir
contacto».

**Qué puedes mandar por WhatsApp** (los tamaños salen de las reglas del
canal, `outbound-files.ts`):

| Tipo | Formatos | Tamaño máximo |
|---|---|---|
| Fotos | JPG, PNG | 5 MB |
| Documentos | PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), TXT, CSV | 100 MB |
| Audio | MP3, OGG, AAC, AMR, M4A | 16 MB |
| Video | MP4, 3GP | 16 MB |

*(Solo si están encendidos)* Instagram: fotos 8 MB, **solo PDF** como
documento, video 25 MB. Messenger: hasta 25 MB.

Las fotos WebP, GIF o del iPhone se convierten solas a JPG. Los archivos se
borran del CRM a los 30 días (el cliente los conserva en su teléfono).

**¿Y si me sale un aviso?**
- «Formato antiguo de Office (.doc/.xls/.ppt) no permitido»: abre el archivo
  y usa «Guardar como» → .docx / .xlsx / .pptx (el menú «Adjuntar» te lo
  recuerda).
- «Imagen HEIC/AVIF no soportada»: conviértela a JPG o mándale captura.
- «no se aceptan archivos comprimidos (zip, rar…)»: envía los archivos uno
  por uno.
- «El archivo excede el límite…»: es muy pesado; comprímelo o envía un PDF
  más ligero.
- «el documento de Office contiene macros» / «el PDF contiene código»: por
  seguridad no se puede enviar; pide una versión limpia.

Captura: `adjunto.png`

---

## 4. `catalogo` — Productos · «Quiero mandarle un producto»

Índice: Fotos y fichas desde el Catálogo, o con su atajo.

**Intro:** el **Catálogo** guarda las fotos y fichas de los productos para
que las mandes sin buscarlas en tu computadora. Se mandan desde el chat del
cliente; «Catálogo» en el menú sirve para ver los productos y copiar su atajo.

**Desde el chat:**
1. En el chat haz clic en el botón «Catálogo», junto a «Adjuntar».
2. Busca por «Nombre o código» o elige una categoría.
3. Abre el producto, marca las fotos o fichas que quieras y haz clic en
   «Agregar». Con «Insertar detalles» pegas además su descripción en el
   mensaje.
4. Envía. Primero sale tu texto y después los archivos, en ese orden.

**Con su atajo** (032):
1. En el menú, abre «Catálogo». Arriba dice «Para mandarle un producto a un
   cliente:» y cada producto trae sus atajos, por ejemplo `/fotos_sal-014`
   (sus fotos) o `/ficha_sal-014` (su ficha).
2. Haz clic en «Copiar» junto al atajo; el botón dice «Copiado».
3. En el chat del cliente, pégalo y elígelo en la lista que aparece: se
   agregan solas sus fotos o su ficha. Revisa y envía.

Atajo: los atajos son respuestas rápidas: también puedes escribirlos
empezando con **/**, sin pasar por «Catálogo».

**¿Y si…?**
- Un producto dice «Pausado: no se puede mandar»: el propietario lo pausó
  (por ejemplo, porque se agotó) y no aparece en «Catálogo» dentro del chat
  ni en sus atajos. Ofrécele otro parecido; si el cliente lo quiere,
  pregúntale al propietario cuándo vuelve.
- Dice «Sin fotos todavía: pídele al propietario que las suba.» o «Sin ficha
  PDF»: a ese producto le falta algo. Pídele al propietario que lo suba y,
  mientras, manda lo que sí tiene.
- Dice «Sin atajo todavía»: mándalo desde «Catálogo» en el chat.
- Sale «No se pudo copiar: escribe … en el chat.»: tu navegador no dejó
  copiar; escribe el atajo tal cual.
- «Todavía no hay productos» o «El catálogo está vacío.»: pídele al
  propietario que suba los productos.
- Un archivo dice «No se puede mandar por aquí: …»: ese canal no acepta ese
  tipo de archivo; elige otro.
- Un archivo dice «No compatible · no se envía»: ese canal no acepta ese
  tipo de archivo; quítalo.
- Máximo 10 archivos por envío.
- Si ya tenías un archivo de «Adjuntar», quítalo para usar el catálogo (no
  se mezclan).

(«Le falta: …» y «Listo para mandar» solo los ve el Propietario: la guía es
para vendedores.)

Captura: `catalogo.png` (panel «Catálogo» del chat) y `catalogo-atajos.png`
(032: «Catálogo» del menú visto por la vendedora, con «Copiar» y un pausado)

---

## 5. `mis-chats` — Organizarte · «¿Qué chats me tocan?»

Índice: Mis chats, Buzón y quién está esperando.

**Intro:** arriba de la lista hay dos pestañas, y debajo de ellas una frase
que te dice qué hay en cada una.

- «Mis chats»: «Chats a tu nombre. Empieza por los que esperan respuesta.»
  **Empieza aquí.**
- «Buzón»: chats que nadie ha tomado. Cada uno trae su botón «Tomar»: un clic
  y queda a tu nombre, sin abrirlo. Si le contestas a uno del Buzón, también
  se vuelve tuyo.

**Lo que te toca ahora:** cuando no tienes ningún chat abierto, a la derecha
verás «Esto es lo que te toca ahora:» con accesos como «… clientes esperan
respuesta», «A … chats se les cierra la ventana en menos de 2 h» o «… chats
en el Buzón sin tomar». Haz clic en uno y te lleva a esos chats.

**Quién está esperando:** en la vista «Por atender» ves a los clientes que
esperan tu respuesta. El aviso «Esperando · …» se pone **rojo** cuando ya se
atrasó. Cuando resuelvas, abre «Mostrar detalles» y haz clic en «Marcar como
atendida»; te preguntará si sigues tú o se lo devuelves a la IA.

**Devolver y archivar:** si ya no puedes atender un chat tuyo, usa «Devolver
al buzón». Con «Archivar» lo quitas de la lista; si el cliente vuelve a
escribir, regresa solo.

**¿Y si…?** «Ya la tomó otro vendedor.»: otro compañero lo tomó antes; busca
otro en el Buzón.

Captura: `mis-chats.png`

---

## 5b. `seguimiento` — Seguimiento · «¿En qué va cada cliente?» *(032)*

Índice: El tablero: qué te toca y el siguiente paso de cada cliente.

*(Sin bandera. `topics.ts` solo condiciona temas enteros por la agenda, no
bloques: por eso este tema no menciona citas.)*

**Intro:** en «Seguimiento» del menú cada columna es una etapa (por ejemplo
«Nuevo», «En conversación», «Interesado») y cada tarjeta es un cliente. La
tarjeta te dice quién lo atiende, si espera tu respuesta y qué sigue.

1. Arriba elige qué ver: «Mis clientes» (los tuyos; empiezas aquí), «Sin
   tomar» (nadie los atiende todavía) o «Todos». Cada uno dice cuántos hay, y
   la pantalla recuerda lo que elegiste.
2. Debajo, unas tarjetas de color te dicen lo que te toca, como «… clientes
   tuyos esperan tu respuesta» o «Venta sin monto». Haz clic en una y te
   lleva a lo que falta.
3. Cada cliente trae su siguiente paso: «Tomar y responder» (el chat queda a
   tu nombre y se abre), «Abrir chat», o «Retomar con plantilla» si su chat
   ya se cerró.
4. Para cambiarlo de etapa, arrastra la tarjeta a otra columna, o haz clic en
   ella y elige la etapa en su panel.
5. Con «Poner monto» anotas cuánto vale el trato; abajo de cada columna ves
   la suma.

**Cuando compra o no compra:** si compró, muévelo a la columna que dice «ya
compró». Si lo mueves a «Perdido», te preguntamos «¿Por qué se perdió?»:
elige el motivo; así se sabe qué mejorar.

**¿Y si…?**
- **La tarjeta dice «Lo atiende …»:** ese cliente es de otro compañero y solo
  él abre su chat. Si necesitas algo, pídeselo.
- **«… ya tomó el chat de …»:** otro compañero lo tomó antes que tú; busca
  otro en «Sin tomar».
- **Compró, pero no sabes cuánto:** muévelo igual. La tarjeta dirá «Compró,
  pero falta cuánto.» y te deja «Capturar monto» para ponerlo cuando lo
  sepas; sin monto no suma en las ventas del mes.
- **«No se pudo cargar el tablero.»:** revisa tu conexión y haz clic en
  «Reintentar».

Captura: `seguimiento.png`

---

## 5c. `contactos` — Contactos · «Quiero escribirle a un contacto» *(032)*

Índice: Cada contacto te dice cómo va su chat y qué puedes hacer hoy.

*(Sin bandera. Lo de Instagram/Messenger va en su propio bloque «¿Y si…?»
con `soloCanal`, para que con `CHANNELS=whatsapp` no se nombren.)*

**Intro:** en «Contactos» del menú están todas las personas que te han
escrito y las que se dieron de alta a mano. Cada fila dice quién lo atiende,
cómo va su chat y trae el botón de lo que puedes hacer hoy.

1. Arriba elige «Activos» (con quienes trabajas) o «Archivados» (los que
   guardaste aparte); cada uno dice cuántos hay. Puedes buscar por nombre o
   teléfono, o filtrar por «Etapa».
2. Debajo del nombre, la fila te dice cómo va su chat, por ejemplo «Te
   escribió … · puedes escribirle libremente … más» o «No te escribe desde
   hace … · para retomarlo usa un mensaje aprobado».
3. Haz clic en su botón: «Abrir chat» (se abre en la Bandeja), «Tomar y
   responder» (nadie lo atiende todavía: queda a tu nombre y se abre su
   chat), «Retomar con plantilla» (su chat se cerró) o «Escribir primero»
   (nunca te ha escrito).

**Escribir primero:**
1. Haz clic en «Escribir primero». Se abre «Escribirle a … por primera vez».
2. En «Elige el mensaje» marca uno y en «Completa los espacios» llena lo que
   falte. Si el mensaje saluda, el nombre ya viene puesto: revisa que esté
   bien.
3. En «Revisa y envía» ves cómo le va a llegar. Haz clic en «Enviar y abrir
   el chat»: te lleva a su chat, y cuando te conteste podrás escribir normal.

**Alguien que no te ha escrito:** con «Nuevo contacto» lo das de alta con su
nombre y su teléfono completo, con código de país (52 para México). Su fila
dirá «Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado»; usa
«Escribir primero».

**Archivar:** «Archivar» lo quita de «Activos» sin borrar nada. Verás
«Archivaste a … Ya no aparece en Activos.» con «Deshacer», por si te
equivocaste. Para regresarlo después, búscalo en «Archivados» y haz clic en
«Desarchivar».

**¿Y si…?**
- **Dice «Sin teléfono: no hay a dónde mandarle el primer mensaje»:** llegó
  sin número (WhatsApp ya no siempre lo manda). Cuando te escriba, aparecerá
  su chat y podrás contestarle.
- **Dice «Lo atiende …»:** es cliente de otro compañero y solo él abre su
  chat; por eso no trae botón. Si necesitas algo, pídeselo.
- **«… ya tomó el chat de …»:** otro compañero lo tomó antes que tú; se queda
  con él.
- **«No se pudieron cargar los contactos.»:** revisa tu conexión y haz clic
  en «Reintentar».

**¿Y en Instagram/Messenger?** *(solo con ese canal encendido)* Ahí no
hay plantillas ni «Escribir primero»: solo puedes contestarle cuando te
escribe. Si te escribió hace más de 24 horas, aún puedes contestarle hasta 7
días (la fila dice cuánto queda); después, espera a que te vuelva a escribir.

Captura: `contactos.png`

---

## 5d. `recordatorios` — Recordatorios · «Quiero acordarme de volver a escribirle» *(035)*

Índice: «Recordarme», la lista de «Pendientes» y la campana de avisos.

**Intro:** Cuando un cliente te pide que le escribas después (por ejemplo,
cuando lleguen modelos nuevos o para su próximo servicio), deja un
**recordatorio**. Solo lo ves tú: el cliente no recibe nada. Todos tus
recordatorios quedan en «Seguimiento», en la vista «Pendientes».

**Dejar un recordatorio**
1. En el chat, en la tarjeta del cliente en «Seguimiento» o en su fila de
   «Contactos», haz clic en «Recordarme».
2. En «¿Cuándo?» elige «Mañana», «En 3 días», «En 1 semana» o «En 1 mes», o
   pon tú el día y la hora. La hora es la del negocio.
3. En «Motivo» marca de qué se trata: «Volver a contactar», «Servicio»,
   «Información solicitada», «Cita» u «Otro».
4. Si es algo que se repite, como un servicio, en «Repetir» elige «Cada 3
   meses», «Cada 6 meses» o «Cada 12 meses»: al marcarlo como hecho, el
   siguiente se agenda solo.
5. Si quieres, escribe una nota y haz clic en «Guardar recordatorio». Abajo
   ves los que ya tienes de ese cliente.

**Tu lista de Pendientes**
1. En «Seguimiento» del menú, arriba cambia de «Tablero» a «Pendientes». Si
   junto a «Seguimiento» ves un número rojo, son recordatorios vencidos.
2. En «Mis recordatorios» aparecen primero los «Vencidos» y los de «Hoy».
   «Esta semana» (hasta el domingo) y «Después» vienen plegados. Con
   «Motivo» filtras por tipo.
3. «Contactar» abre su chat; si nunca te ha escrito, dice «Escribir primero».
4. Cuando ya le escribiste, «Hecho» (con «¿Qué pasó?» opcional, que queda en
   el historial). Si se repite, te dice para cuándo quedó el siguiente.
5. «Posponer ▾»: «1 hora», «Mañana a la misma hora», «1 semana» u «Otra
   fecha y hora…».

**Clientes que se te pueden enfriar:** «Sin contacto» (15/30/60/90 días o
«Entre fechas»; «Incluir perdidos») y «Sin respuesta a tu plantilla» (3/7/14
días, dice si ya la leyeron), con «Contactar», «Dar seguimiento» o
«Recordarme». Cada lista enseña 3 y «Ver los …» abre el resto.

**¿Y si…?**
- **No ves el recordatorio de un compañero:** cada quien ve solo los suyos;
  el propietario ve los de todos con «Vendedor».
- **Las listas están vacías:** nadie lleva tanto tiempo así; prueba con menos
  días.
- **¿El cliente se entera?** No; para escribirle usa «Contactar».

**Los avisos: la campana** *(035 B)*
1. Al llegar la hora: abajo a la derecha «Recordatorio: …» con «Contactar»
   y «Posponer 1 h»; se queda hasta que elijas o lo cierres.
2. La campana, junto al nombre del negocio: «Recordatorio vencido», «Hoy
   tienes … recordatorios», «Te asignaron a …» y las citas que te tocan. El
   número rojo son los no vistos.
3. Desde un vencido: «Contactar» o «Posponer ▾»; «Marcar todo como leído».
4. «Activar avisos del navegador» para el aviso fuera de la pestaña.

**En la Bandeja:** «… recordatorios para hoy (… vencidos)» lleva a
«Pendientes».

**¿Y si…?** «Bloqueaste los avisos en este navegador»: candado junto a la
dirección › «Notificaciones» › «Permitir». La campana funciona igual.

Captura: `recordarme.png`, `pendientes.png`, `avisos.png`

---

## 6. `ia` — Trabajar con la IA · «¿Cuándo contesta la IA y cuándo yo?»

Índice: Cómo tomar un chat sin que respondan los dos.

**Intro:** {negocio} tiene un asistente con IA que responde a los clientes.
Arriba de cada chat, una franja te dice quién está respondiendo.

- «La IA está respondiendo a …»: si vas a contestar tú, haz clic en «Atender
  yo». El chat queda a tu nombre (si nadie lo tenía) y la IA se pone en
  pausa, para que no respondan los dos.
- Si empiezas a escribir con la IA encendida, arriba de la caja te pregunta
  «¿La pausamos mientras atiendes tú?». «Sí, atiendo yo» la pausa; «No, que
  siga» la deja contestar y no te vuelve a preguntar en ese chat. Escribir
  no la pausa sola.
- «Tú atiendes este chat. La IA está en pausa…»: la IA no le escribirá.
  Cuando termines, «Devolver a la IA» hace que siga ella.
- «… pidió hablar con una persona.»: la IA ya le avisó al cliente que le
  responderán por ese chat. **Esos chats son prioridad:** haz clic en
  «Responder a …» y contéstale tú. Si la IA se detuvo por otro motivo, la
  franja te lo dice.
- Cuando acabes con un chat escalado, en «Mostrar detalles» puedes usar
  «Reactivar IA» o «Marcar como atendida».

Nota (en la lista): los chats que está contestando la IA llevan la etiqueta
«Responde la IA». Si respondes desde el teléfono del negocio, la IA se pausa
sola en ese chat.

Captura: `ia.png`

---

## 7. `citas` — Agenda · «El cliente quiere una cita» *(solo con AGENDA)*

Índice: Agéndala desde el chat y luego marca cómo le fue. *(032)*

**Intro:** desde el mismo chat puedes apartarle un horario al cliente; la
cita queda en «Citas» del menú, donde además ves lo que te toca.

1. En el chat haz clic en «Agendar».
2. Elige el «Tipo de cita», el «Día» y el «Horario».
3. Agrega «Notas» si hace falta y haz clic en «Guardar».
4. Verás «Cita agendada para …». La encuentras en «Citas» del menú, en
   vista «Semana», «Día» o «Lista». Arriba eliges «Mías», «Sin vendedor» o
   «Todas».

**Lo que te toca en «Citas»:** arriba del calendario ves tus citas de hoy y
de mañana. Si una cita tuya ya pasó y nadie dijo cómo salió, aparece «¿Cómo
le fue a …?»: elige «Sí, llegó», «No asistió» o «Reprogramar».

**Citas sin vendedor:** si hay una cita que nadie tiene, verás «… cita sin
vendedor» con el botón «Tomarla»: un clic y queda a tu nombre.

**Bloquear un horario:** abajo, en «Bloquear un horario», apartas un rato
(comida, junta, inventario). Ojo: **cierra la agenda de todo el negocio**;
nadie podrá agendar en ese tiempo, ni la IA ni el equipo. Si ya había una
cita a esa hora, te lo avisa: sigue agendada y tú decides si la mueves.

Nota (las horas): todo se ve en la hora del negocio; arriba dice cuál, por
ejemplo «Horarios en hora de Ciudad de México.».

**¿Y si…?**
- Un horario dice «Ocupado»: ya hay otra cita a esa hora; elige otro.
- «No hay horarios disponibles.»: prueba otro día u otro tipo de cita.
- «Otro vendedor ya la tomó.»: un compañero tomó esa cita antes que tú; ya no
  aparece en tu lista.
- Una cita dice «La agendó la IA» o «La agendó una persona»: así sabes quién
  la apartó.

*(032: «Sin asignar» ahora es «Sin vendedor»; «Manual» es «La agendó una
persona»; «Mostrar pruebas» ya no se le muestra al vendedor.)*

Captura: `cita.png`, `citas.png`

---

## 8. `ventana-24h` — La regla de las 24 horas · «¿Cuánto tiempo tengo para responder?»

Índice: La regla de las 24 horas de WhatsApp.

**Intro:** WhatsApp solo te deja escribir libremente durante las **24 horas**
siguientes al último mensaje del cliente. Pasado ese tiempo, la caja de texto
desaparece. No es una falla del sistema: es una regla de WhatsApp.

**Cómo saber cuánto tiempo te queda:**
1. Abajo de la caja de texto verás «Puedes escribirle libremente … más», con
   una barra que se va acortando. Ese es tu tiempo para responder con
   mensajes normales.
2. Cuando faltan menos de 2 horas cambia a «Se cierra en … · responde ya».
3. En la lista de chats, el aviso «Cierra en …» te dice lo mismo. En
   «Filtros» puedes elegir «Por cerrar» para ver solo esos chats.

*(Solo si Instagram o Messenger están encendidos)* **En Instagram y
Messenger** la regla es un poco distinta: después de 24 horas aún puedes
responder hasta **7 días** (abajo dirá «Fuera de las 24 h · tu respuesta sale
como agente humano» y cuánto queda). Pasados 7 días verás «Todavía no puedes
escribirle» hasta que el cliente vuelva a escribir. Ahí no hay plantillas.

**¿Y si ya se cerró?** Verás «Para escribirle a …, usa un mensaje aprobado».
No pasa nada: manda una **plantilla** (ver «Ya no puedo escribirle al
cliente»). En cuanto el cliente te conteste, la ventana se abre otra vez por
24 horas.

Captura: `ventana-abierta.png`, `ventana-cerrada.png`
