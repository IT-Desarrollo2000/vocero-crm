/**
 * 031 — Textos de la guía para vendedores (`/ayuda`). FUENTE ÚNICA de la
 * página; la pantalla de chats ya no lleva botones «?» (rebanada 4: se
 * explica sola).
 *
 * Se transcribe de `specs/031-guia-vendedores/contenido.md`. Las etiquetas
 * entre «» son las que se ven en pantalla: si una cambia en la UI, cámbiala
 * allá y aquí.
 *
 * Marcado mínimo dentro de los textos (lo interpreta `parseInline`):
 * `**negrita**`, `*cursiva*`, `` `código` `` y `«etiqueta de la pantalla»`.
 * `{negocio}` es el nombre de la instancia (`fillBrand`); `{{negocio}}` NO:
 * es el comodín de las respuestas rápidas y se muestra tal cual.
 *
 * Puro y sin imports de servidor.
 */

import {
  INSTAGRAM_OUTBOUND_FILES,
  MESSENGER_OUTBOUND_FILES,
  WHATSAPP_OUTBOUND_FILES,
  type OutboundFileKind,
  type OutboundFiles,
} from "@/lib/outbound-files";

/** Canales con párrafos propios en la guía (WhatsApp es el de siempre). */
export type HelpChannel = "instagram" | "messenger";

export type HelpBlockBase = {
  /** Encabezado corto del bloque («Pasos:», «¿Y si…?»…). */
  titulo?: string;
  /** Solo se muestra si ALGUNO de estos canales está encendido. */
  soloCanal?: HelpChannel[];
  /**
   * Cómo se pinta: normal, nota al margen o «¿Y si…?» (va en su caja, al
   * final del tema, después de la captura).
   */
  tono?: "normal" | "siNo" | "nota";
};

export type HelpBlock = HelpBlockBase &
  (
    | { tipo: "parrafo"; texto: string }
    | { tipo: "pasos"; items: string[] }
    | { tipo: "lista"; items: string[] }
    | { tipo: "tabla"; columnas: string[]; filas: string[][] }
  );

export type HelpTopic = {
  /** Ancla de la página (`/ayuda#<id>`). */
  id: string;
  /** Antetítulo corto del artículo («Retomar un chat»). */
  antetitulo: string;
  /** La situación, en palabras del vendedor (índice y título del tema). */
  titulo: string;
  /** Una línea bajo el título en el índice. */
  resumen: string;
  /** Qué pasa, en un párrafo, antes de los pasos. */
  intro: string;
  bloques: HelpBlock[];
  /** Archivos en `public/ayuda/`; la página solo pinta los que existen. */
  captura?: string[];
  /** Módulo opcional del que depende el tema entero. */
  requiere?: "agenda";
};

// ── Encabezado ───────────────────────────────────────────────────────────

export const HELP_HEADER = {
  titulo: "Guía rápida de {negocio}",
  intro:
    "Todo para atender a tus clientes por WhatsApp sin complicarte. Elige lo que te está pasando y sigue los pasos.",
} as const;

// ── Formatos por canal (tema `archivos`) ─────────────────────────────────

const MB = 1024 * 1024;

/** Cuántos MB permite una regla del canal (entero, como en la guía). */
export function ruleMb(files: OutboundFiles, kind: OutboundFileKind): number | null {
  const rule = files.rules.find((r) => r.kind === kind);
  return rule ? Math.round(rule.maxBytes / MB) : null;
}

const WA_FORMATS: Record<OutboundFileKind, { tipo: string; formatos: string }> = {
  image: { tipo: "Fotos", formatos: "JPG, PNG" },
  document: {
    tipo: "Documentos",
    formatos: "PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), TXT, CSV",
  },
  audio: { tipo: "Audio", formatos: "MP3, OGG, AAC, AMR, M4A" },
  video: { tipo: "Video", formatos: "MP4, 3GP" },
};

/**
 * Tabla «Qué puedes mandar por WhatsApp»: los tamaños salen de las reglas
 * reales del canal (`outbound-files.ts`), así no se desincronizan.
 */
function whatsappFilesTable(): string[][] {
  const order: OutboundFileKind[] = ["image", "document", "audio", "video"];
  return order.flatMap((kind) => {
    const mb = ruleMb(WHATSAPP_OUTBOUND_FILES, kind);
    const row = WA_FORMATS[kind];
    return mb === null ? [] : [[row.tipo, row.formatos, `${mb} MB`]];
  });
}

const IG_IMAGE_MB = ruleMb(INSTAGRAM_OUTBOUND_FILES, "image");
const IG_VIDEO_MB = ruleMb(INSTAGRAM_OUTBOUND_FILES, "video");
const MS_MAX_MB = ruleMb(MESSENGER_OUTBOUND_FILES, "document");

// ── Temas ────────────────────────────────────────────────────────────────

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "plantillas",
    antetitulo: "Retomar un chat",
    titulo: "Ya no puedo escribirle al cliente",
    resumen: "Pasaron 24 horas: retómalo con una plantilla.",
    intro:
      "WhatsApp solo deja escribir libremente durante las 24 horas siguientes al último mensaje del cliente. Después, la única forma de escribirle es con una **plantilla**: un mensaje que WhatsApp ya aprobó. No es una falla: es una regla de WhatsApp.",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "Abre el chat. Donde estaba la caja de texto verás «Para escribirle a …, usa un mensaje aprobado».",
          "En «Elige el mensaje» marca el que mejor quede (por ejemplo, un seguimiento de cotización).",
          "En «Completa los espacios» llena cada espacio; abajo de cada uno ves en qué parte del mensaje va. Si el mensaje empieza con un saludo, el nombre del cliente ya viene puesto: revisa que esté bien.",
          "Revisa en «Revisa y envía» cómo le va a llegar y haz clic en «Enviar plantilla». Cuando te conteste, ya puedes escribir normal.",
        ],
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si…?",
        items: [
          "**No aparece ningún mensaje para elegir:** verás «Todavía no puedes retomar este chat». Tu equipo aún no tiene plantillas; pídele al propietario que cree una (WhatsApp tarda desde unos minutos hasta un día en aprobarla).",
          "**No se activa «Enviar plantilla»:** te falta llenar un espacio; abajo del botón dice cuál («Llena el espacio … para poder enviarla.»).",
          "**Los botones de «Pegar texto de plantilla» (con la ventana abierta):** esos solo pegan el texto en tu mensaje para ahorrarte escribir; no son plantillas oficiales.",
        ],
      },
    ],
    captura: ["plantilla-enviar.png"],
  },
  {
    id: "respuestas-rapidas",
    antetitulo: "Ahorrar tiempo",
    titulo: "Siempre escribo lo mismo",
    resumen: "Usa respuestas rápidas con la diagonal /.",
    intro:
      "Las **respuestas rápidas** son mensajes guardados (horario, ubicación, formas de pago…) que pegas en un segundo.",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "Arriba de la caja de texto verás «Respuestas rápidas» con las primeras como botones, por ejemplo «/horario · Horario». Un clic y el texto queda en tu mensaje.",
          "Para ver todas, escribe **/** (la diagonal) en la caja y sigue escribiendo para buscar, por ejemplo `/horario`.",
          "Elige con las flechas ↑ ↓ y presiona **Enter** (o haz clic).",
          "El texto queda en tu mensaje: **revísalo o cámbialo** y luego envíalo. No se manda solo.",
        ],
      },
      {
        tipo: "parrafo",
        titulo: "Se llenan solas",
        texto:
          "Si la respuesta dice `{{nombre}}`, se cambia por el nombre del cliente; `{{vendedor}}` por tu nombre; `{{negocio}}` por {negocio}.",
      },
      {
        tipo: "parrafo",
        titulo: "Crear la tuya *(si el propietario lo permite)*",
        texto:
          "Escribe tu mensaje y haz clic en «Guardar como respuesta rápida» debajo de la caja, o elige «+ Nueva respuesta rápida» al final de la lista. Ponle un atajo corto (por ejemplo `pagos`). Queda para todo el equipo. Puedes editar o borrar las tuyas en «Ajustes» → «Respuestas rápidas».",
      },
      {
        tipo: "parrafo",
        tono: "siNo",
        titulo: "¿Y si…?",
        texto:
          "No ves «Guardar como respuesta rápida»: el propietario tiene apagada esa opción; pídele que agregue la respuesta.",
      },
    ],
    captura: ["respuestas-rapidas.png"],
  },
  {
    id: "archivos",
    antetitulo: "Mandar archivos",
    titulo: "Quiero mandar un documento o foto",
    resumen: "Qué se puede mandar y qué hacer si no se deja.",
    intro:
      "Desde el chat puedes mandar fotos, documentos, video y audio. Antes de elegir el archivo, la pantalla te dice qué formatos acepta el canal y hasta cuánto pesa cada tipo.",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "Haz clic en «Adjuntar», junto a la caja de texto. Se abre «¿Qué quieres mandar?» con cada tipo («Foto», «Documento», «Video», «Audio»), sus formatos y su tamaño máximo.",
          "Elige el tipo y luego el archivo en tu computadora.",
          "Lo que escribas en la caja se envía como **pie** del archivo (es opcional). Envía.",
        ],
      },
      {
        tipo: "parrafo",
        tono: "nota",
        titulo: "En WhatsApp",
        texto:
          "En el mismo menú están «Enviar ubicación» y «Compartir contacto».",
      },
      {
        tipo: "tabla",
        titulo: "Qué puedes mandar por WhatsApp",
        columnas: ["Tipo", "Formatos", "Tamaño máximo"],
        filas: whatsappFilesTable(),
      },
      {
        tipo: "parrafo",
        tono: "nota",
        soloCanal: ["instagram"],
        texto: `**Instagram:** fotos ${IG_IMAGE_MB} MB, **solo PDF** como documento, video ${IG_VIDEO_MB} MB.`,
      },
      {
        tipo: "parrafo",
        tono: "nota",
        soloCanal: ["messenger"],
        texto: `**Messenger:** hasta ${MS_MAX_MB} MB.`,
      },
      {
        tipo: "parrafo",
        texto:
          "Las fotos WebP, GIF o del iPhone se convierten solas a JPG. Los archivos se borran del CRM a los 30 días (el cliente los conserva en su teléfono).",
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si me sale un aviso?",
        items: [
          "«Formato antiguo de Office (.doc/.xls/.ppt) no permitido»: abre el archivo y usa «Guardar como» → .docx / .xlsx / .pptx (el menú «Adjuntar» te lo recuerda).",
          "«Imagen HEIC/AVIF no soportada»: conviértela a JPG o mándale captura.",
          "«no se aceptan archivos comprimidos (zip, rar…)»: envía los archivos uno por uno.",
          "«El archivo excede el límite…»: es muy pesado; comprímelo o envía un PDF más ligero.",
          "«el documento de Office contiene macros» / «el PDF contiene código»: por seguridad no se puede enviar; pide una versión limpia.",
        ],
      },
    ],
    captura: ["adjunto.png"],
  },
  {
    id: "catalogo",
    antetitulo: "Productos",
    titulo: "Quiero mandarle un producto",
    resumen: "Fotos y fichas desde el Catálogo, o con su atajo.",
    intro:
      "El **Catálogo** guarda las fotos y fichas de los productos para que las mandes sin buscarlas en tu computadora. Se mandan desde el chat del cliente; «Catálogo» en el menú sirve para ver los productos y copiar su atajo.",
    bloques: [
      {
        tipo: "pasos",
        titulo: "Desde el chat",
        items: [
          "En el chat haz clic en el botón «Catálogo», junto a «Adjuntar».",
          "Busca por «Nombre o código» o elige una categoría.",
          "Abre el producto, marca las fotos o fichas que quieras y haz clic en «Agregar». Con «Insertar detalles» pegas además su descripción en el mensaje.",
          "Envía. Primero sale tu texto y después los archivos, en ese orden.",
        ],
      },
      {
        tipo: "pasos",
        titulo: "Con su atajo",
        items: [
          "En el menú, abre «Catálogo». Arriba dice «Para mandarle un producto a un cliente:» y cada producto trae sus atajos, por ejemplo `/fotos_sal-014` (sus fotos) o `/ficha_sal-014` (su ficha).",
          "Haz clic en «Copiar» junto al atajo; el botón dice «Copiado».",
          "En el chat del cliente, pégalo y elígelo en la lista que aparece: se agregan solas sus fotos o su ficha. Revisa y envía.",
        ],
      },
      {
        tipo: "parrafo",
        tono: "nota",
        titulo: "Atajo",
        texto:
          "Los atajos son respuestas rápidas: también puedes escribirlos empezando con **/**, sin pasar por «Catálogo».",
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si…?",
        items: [
          "Un producto dice «Pausado: no se puede mandar»: el propietario lo pausó (por ejemplo, porque se agotó) y no aparece en «Catálogo» dentro del chat ni en sus atajos. Ofrécele otro parecido; si el cliente lo quiere, pregúntale al propietario cuándo vuelve.",
          "Dice «Sin fotos todavía: pídele al propietario que las suba.» o «Sin ficha PDF»: a ese producto le falta algo. Pídele al propietario que lo suba y, mientras, manda lo que sí tiene.",
          "Dice «Sin atajo todavía»: mándalo desde «Catálogo» en el chat.",
          "Sale «No se pudo copiar: escribe … en el chat.»: tu navegador no dejó copiar; escribe el atajo tal cual.",
          "«Todavía no hay productos» o «El catálogo está vacío.»: pídele al propietario que suba los productos.",
          "Un archivo dice «No se puede mandar por aquí: …»: ese canal no acepta ese tipo de archivo; elige otro.",
          "Un archivo dice «No compatible · no se envía»: ese canal no acepta ese tipo de archivo; quítalo.",
          "Máximo 10 archivos por envío.",
          "Si ya tenías un archivo de «Adjuntar», quítalo para usar el catálogo (no se mezclan).",
        ],
      },
    ],
    captura: ["catalogo.png", "catalogo-atajos.png"],
  },
  {
    id: "mis-chats",
    antetitulo: "Organizarte",
    titulo: "¿Qué chats me tocan?",
    resumen: "Mis chats, Buzón y quién está esperando.",
    intro:
      "Arriba de la lista hay dos pestañas, y debajo de ellas una frase que te dice qué hay en cada una.",
    bloques: [
      {
        tipo: "lista",
        items: [
          "«Mis chats»: «Chats a tu nombre. Empieza por los que esperan respuesta.» **Empieza aquí.**",
          "«Buzón»: chats que nadie ha tomado. Cada uno trae su botón «Tomar»: un clic y queda a tu nombre, sin abrirlo. Si le contestas a uno del Buzón, también se vuelve tuyo.",
        ],
      },
      {
        tipo: "parrafo",
        titulo: "Lo que te toca ahora",
        texto:
          "Cuando no tienes ningún chat abierto, a la derecha verás «Esto es lo que te toca ahora:» con accesos como «… clientes esperan respuesta», «A … chats se les cierra la ventana en menos de 2 h» o «… chats en el Buzón sin tomar». Haz clic en uno y te lleva a esos chats.",
      },
      {
        tipo: "parrafo",
        titulo: "Quién está esperando",
        texto:
          "En la vista «Por atender» ves a los clientes que esperan tu respuesta. El aviso «Esperando · …» se pone **rojo** cuando ya se atrasó. Cuando resuelvas, abre «Mostrar detalles» y haz clic en «Marcar como atendida»; te preguntará si sigues tú o se lo devuelves a la IA.",
      },
      {
        tipo: "parrafo",
        titulo: "Devolver y archivar",
        texto:
          "Si ya no puedes atender un chat tuyo, usa «Devolver al buzón». Con «Archivar» lo quitas de la lista; si el cliente vuelve a escribir, regresa solo.",
      },
      {
        tipo: "parrafo",
        tono: "siNo",
        titulo: "¿Y si…?",
        texto:
          "«Ya la tomó otro vendedor.»: otro compañero lo tomó antes; busca otro en el Buzón.",
      },
    ],
    captura: ["mis-chats.png"],
  },
  {
    id: "seguimiento",
    antetitulo: "Seguimiento",
    titulo: "¿En qué va cada cliente?",
    resumen: "El tablero: qué te toca y el siguiente paso de cada cliente.",
    intro:
      "En «Seguimiento» del menú cada columna es una etapa (por ejemplo «Nuevo», «En conversación», «Interesado») y cada tarjeta es un cliente. La tarjeta te dice quién lo atiende, si espera tu respuesta y qué sigue.",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "Arriba elige qué ver: «Mis clientes» (los tuyos; empiezas aquí), «Sin tomar» (nadie los atiende todavía) o «Todos». Cada uno dice cuántos hay, y la pantalla recuerda lo que elegiste.",
          "Debajo, unas tarjetas de color te dicen lo que te toca, como «… clientes tuyos esperan tu respuesta» o «Venta sin monto». Haz clic en una y te lleva a lo que falta.",
          "Cada cliente trae su siguiente paso: «Tomar y responder» (el chat queda a tu nombre y se abre), «Abrir chat», o «Retomar con plantilla» si su chat ya se cerró.",
          "Para cambiarlo de etapa, arrastra la tarjeta a otra columna, o haz clic en ella y elige la etapa en su panel.",
          "Con «Poner monto» anotas cuánto vale el trato; abajo de cada columna ves la suma.",
        ],
      },
      {
        tipo: "parrafo",
        titulo: "Cuando compra o no compra",
        texto:
          "Si compró, muévelo a la columna que dice «ya compró». Si lo mueves a «Perdido», te preguntamos «¿Por qué se perdió?»: elige el motivo; así se sabe qué mejorar.",
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si…?",
        items: [
          "**La tarjeta dice «Lo atiende …»:** ese cliente es de otro compañero y solo él abre su chat. Si necesitas algo, pídeselo.",
          "**«… ya tomó el chat de …»:** otro compañero lo tomó antes que tú; busca otro en «Sin tomar».",
          "**Compró, pero no sabes cuánto:** muévelo igual. La tarjeta dirá «Compró, pero falta cuánto.» y te deja «Capturar monto» para ponerlo cuando lo sepas; sin monto no suma en las ventas del mes.",
          "**«No se pudo cargar el tablero.»:** revisa tu conexión y haz clic en «Reintentar».",
        ],
      },
    ],
    captura: ["seguimiento.png"],
  },
  {
    id: "contactos",
    antetitulo: "Contactos",
    titulo: "Quiero escribirle a un contacto",
    resumen: "Cada contacto te dice cómo va su chat y qué puedes hacer hoy.",
    intro:
      "En «Contactos» del menú están todas las personas que te han escrito y las que se dieron de alta a mano. Cada fila dice quién lo atiende, cómo va su chat y trae el botón de lo que puedes hacer hoy.",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "Arriba elige «Activos» (con quienes trabajas) o «Archivados» (los que guardaste aparte); cada uno dice cuántos hay. Puedes buscar por nombre o teléfono, o filtrar por «Etapa».",
          "Debajo del nombre, la fila te dice cómo va su chat, por ejemplo «Te escribió … · puedes escribirle libremente … más» o «No te escribe desde hace … · para retomarlo usa un mensaje aprobado».",
          "Haz clic en su botón: «Abrir chat» (se abre en la Bandeja), «Tomar y responder» (nadie lo atiende todavía: queda a tu nombre y se abre su chat), «Retomar con plantilla» (su chat se cerró) o «Escribir primero» (nunca te ha escrito).",
        ],
      },
      {
        tipo: "pasos",
        titulo: "Escribir primero",
        items: [
          "Haz clic en «Escribir primero». Se abre «Escribirle a … por primera vez».",
          "En «Elige el mensaje» marca uno y en «Completa los espacios» llena lo que falte. Si el mensaje saluda, el nombre ya viene puesto: revisa que esté bien.",
          "En «Revisa y envía» ves cómo le va a llegar. Haz clic en «Enviar y abrir el chat»: te lleva a su chat, y cuando te conteste podrás escribir normal.",
        ],
      },
      {
        tipo: "parrafo",
        titulo: "Alguien que no te ha escrito",
        texto:
          "Con «Nuevo contacto» lo das de alta con su nombre y su teléfono completo, con código de país (52 para México). Su fila dirá «Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado»; usa «Escribir primero».",
      },
      {
        tipo: "parrafo",
        titulo: "Archivar",
        texto:
          "«Archivar» lo quita de «Activos» sin borrar nada. Verás «Archivaste a … Ya no aparece en Activos.» con «Deshacer», por si te equivocaste. Para regresarlo después, búscalo en «Archivados» y haz clic en «Desarchivar».",
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si…?",
        items: [
          "**Dice «Sin teléfono: no hay a dónde mandarle el primer mensaje»:** llegó sin número (WhatsApp ya no siempre lo manda). Cuando te escriba, aparecerá su chat y podrás contestarle.",
          "**Dice «Lo atiende …»:** es cliente de otro compañero y solo él abre su chat; por eso no trae botón. Si necesitas algo, pídeselo.",
          "**«… ya tomó el chat de …»:** otro compañero lo tomó antes que tú; se queda con él.",
          "**«No se pudieron cargar los contactos.»:** revisa tu conexión y haz clic en «Reintentar».",
        ],
      },
      {
        tipo: "parrafo",
        tono: "siNo",
        soloCanal: ["instagram", "messenger"],
        titulo: "¿Y en {canalesMeta}?",
        texto:
          "Ahí no hay plantillas ni «Escribir primero»: solo puedes contestarle cuando te escribe. Si te escribió hace más de 24 horas, aún puedes contestarle hasta 7 días (la fila dice cuánto queda); después, espera a que te vuelva a escribir.",
      },
    ],
    captura: ["contactos.png"],
  },
  {
    id: "ia",
    antetitulo: "Trabajar con la IA",
    titulo: "¿Cuándo contesta la IA y cuándo yo?",
    resumen: "Cómo tomar un chat sin que respondan los dos.",
    intro:
      "{negocio} tiene un asistente con IA que responde a los clientes. Arriba de cada chat, una franja te dice quién está respondiendo.",
    bloques: [
      {
        tipo: "lista",
        items: [
          "«La IA está respondiendo a …»: si vas a contestar tú, haz clic en «Atender yo». El chat queda a tu nombre (si nadie lo tenía) y la IA se pone en pausa, para que no respondan los dos.",
          "Si empiezas a escribir con la IA encendida, arriba de la caja te pregunta «¿La pausamos mientras atiendes tú?». «Sí, atiendo yo» la pausa; «No, que siga» la deja contestar y no te vuelve a preguntar en ese chat. Escribir no la pausa sola.",
          "«Tú atiendes este chat. La IA está en pausa…»: la IA no le escribirá. Cuando termines, «Devolver a la IA» hace que siga ella.",
          "«… pidió hablar con una persona.»: la IA ya le avisó al cliente que le responderán por ese chat. **Esos chats son prioridad:** haz clic en «Responder a …» y contéstale tú. Si la IA se detuvo por otro motivo, la franja te lo dice.",
          "Cuando acabes con un chat escalado, en «Mostrar detalles» puedes usar «Reactivar IA» o «Marcar como atendida».",
        ],
      },
      {
        tipo: "parrafo",
        tono: "nota",
        titulo: "En la lista",
        texto:
          "Los chats que está contestando la IA llevan la etiqueta «Responde la IA». Si respondes desde el teléfono del negocio, la IA se pausa sola en ese chat.",
      },
    ],
    captura: ["ia.png"],
  },
  {
    id: "citas",
    antetitulo: "Agenda",
    titulo: "El cliente quiere una cita",
    resumen: "Agéndala desde el chat y luego marca cómo le fue.",
    intro:
      "Desde el mismo chat puedes apartarle un horario al cliente; la cita queda en «Citas» del menú, donde además ves lo que te toca.",
    requiere: "agenda",
    bloques: [
      {
        tipo: "pasos",
        items: [
          "En el chat haz clic en «Agendar».",
          "Elige el «Tipo de cita», el «Día» y el «Horario».",
          "Agrega «Notas» si hace falta y haz clic en «Guardar».",
          "Verás «Cita agendada para …». La encuentras en «Citas» del menú, en vista «Semana», «Día» o «Lista». Arriba eliges «Mías», «Sin vendedor» o «Todas».",
        ],
      },
      {
        tipo: "parrafo",
        titulo: "Lo que te toca en «Citas»",
        texto:
          "Arriba del calendario ves tus citas de hoy y de mañana. Si una cita tuya ya pasó y nadie dijo cómo salió, aparece «¿Cómo le fue a …?»: elige «Sí, llegó», «No asistió» o «Reprogramar».",
      },
      {
        tipo: "parrafo",
        titulo: "Citas sin vendedor",
        texto:
          "Si hay una cita que nadie tiene, verás «… cita sin vendedor» con el botón «Tomarla»: un clic y queda a tu nombre.",
      },
      {
        tipo: "parrafo",
        titulo: "Bloquear un horario",
        texto:
          "Abajo, en «Bloquear un horario», apartas un rato (comida, junta, inventario). Ojo: **cierra la agenda de todo el negocio**; nadie podrá agendar en ese tiempo, ni la IA ni el equipo. Si ya había una cita a esa hora, te lo avisa: sigue agendada y tú decides si la mueves.",
      },
      {
        tipo: "parrafo",
        tono: "nota",
        titulo: "Las horas",
        texto:
          "Todo se ve en la hora del negocio; arriba dice cuál, por ejemplo «Horarios en hora de Ciudad de México.».",
      },
      {
        tipo: "lista",
        tono: "siNo",
        titulo: "¿Y si…?",
        items: [
          "Un horario dice «Ocupado»: ya hay otra cita a esa hora; elige otro.",
          "«No hay horarios disponibles.»: prueba otro día u otro tipo de cita.",
          "«Otro vendedor ya la tomó.»: un compañero tomó esa cita antes que tú; ya no aparece en tu lista.",
          "Una cita dice «La agendó la IA» o «La agendó una persona»: así sabes quién la apartó.",
        ],
      },
    ],
    captura: ["cita.png", "citas.png"],
  },
  {
    id: "ventana-24h",
    antetitulo: "La regla de las 24 horas",
    titulo: "¿Cuánto tiempo tengo para responder?",
    resumen: "La regla de las 24 horas de WhatsApp.",
    intro:
      "WhatsApp solo te deja escribir libremente durante las **24 horas** siguientes al último mensaje del cliente. Pasado ese tiempo, la caja de texto desaparece. No es una falla del sistema: es una regla de WhatsApp.",
    bloques: [
      {
        tipo: "pasos",
        titulo: "Cómo saber cuánto tiempo te queda",
        items: [
          "Abajo de la caja de texto verás «Puedes escribirle libremente … más», con una barra que se va acortando. Ese es tu tiempo para responder con mensajes normales.",
          "Cuando faltan menos de 2 horas cambia a «Se cierra en … · responde ya».",
          "En la lista de chats, el aviso «Cierra en …» te dice lo mismo. En «Filtros» puedes elegir «Por cerrar» para ver solo esos chats.",
        ],
      },
      {
        tipo: "parrafo",
        tono: "nota",
        soloCanal: ["instagram", "messenger"],
        titulo: "En {canalesMeta}",
        texto:
          "La regla es un poco distinta: después de 24 horas aún puedes responder hasta **7 días** (abajo dirá «Fuera de las 24 h · tu respuesta sale como agente humano» y cuánto queda). Pasados 7 días verás «Todavía no puedes escribirle» hasta que el cliente vuelva a escribir. Ahí no hay plantillas.",
      },
      {
        tipo: "parrafo",
        tono: "siNo",
        titulo: "¿Y si ya se cerró?",
        texto:
          "Verás «Para escribirle a …, usa un mensaje aprobado». No pasa nada: manda una **plantilla** (ver «Ya no puedo escribirle al cliente»). En cuanto el cliente te conteste, la ventana se abre otra vez por 24 horas.",
      },
    ],
    captura: ["ventana-abierta.png", "ventana-cerrada.png"],
  },
];

// ── Marca y banderas ─────────────────────────────────────────────────────

/**
 * Cambia `{negocio}` por el nombre de la instancia. `{{negocio}}` (comodín de
 * las respuestas rápidas) se queda tal cual.
 */
export function fillBrand(text: string, name: string): string {
  return text.replace(/(?<!\{)\{negocio\}(?!\})/g, () => name);
}

function channelsLabel(channels: HelpChannel[]): string {
  const names = channels.map((c) => (c === "instagram" ? "Instagram" : "Messenger"));
  return names.join(" y ");
}

/**
 * Temas y bloques que existen en ESTA instancia: sin agenda no hay tema de
 * citas; sin Instagram/Messenger no hay sus párrafos. `{canalesMeta}` se
 * llena con los canales encendidos de la lista del bloque.
 */
export function visibleTopics(opts: {
  agenda: boolean;
  channels: Iterable<string>;
}): HelpTopic[] {
  const on = new Set(opts.channels);
  return HELP_TOPICS.filter((t) => t.requiere !== "agenda" || opts.agenda).map(
    (t) => ({
      ...t,
      bloques: t.bloques.flatMap((b): HelpBlock[] => {
        if (!b.soloCanal) return [b];
        const active = b.soloCanal.filter((c) => on.has(c));
        if (active.length === 0) return [];
        const label = channelsLabel(active);
        return [
          { ...b, titulo: b.titulo?.replace("{canalesMeta}", label) },
        ];
      }),
    })
  );
}

// ── Marcado en línea ─────────────────────────────────────────────────────

export type InlineSegment =
  | { tipo: "texto"; valor: string }
  | { tipo: "negrita"; valor: string }
  | { tipo: "cursiva"; valor: string }
  | { tipo: "codigo"; valor: string }
  | { tipo: "etiqueta"; valor: string };

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|«[^»]+»)/g;

/** Parte un texto en segmentos según el marcado mínimo de la guía. */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ tipo: "texto", valor: text.slice(last, at) });
    if (raw.startsWith("**")) out.push({ tipo: "negrita", valor: raw.slice(2, -2) });
    else if (raw.startsWith("*")) out.push({ tipo: "cursiva", valor: raw.slice(1, -1) });
    else if (raw.startsWith("`")) out.push({ tipo: "codigo", valor: raw.slice(1, -1) });
    else out.push({ tipo: "etiqueta", valor: raw.slice(1, -1) });
    last = at + raw.length;
  }
  if (last < text.length) out.push({ tipo: "texto", valor: text.slice(last) });
  return out;
}
