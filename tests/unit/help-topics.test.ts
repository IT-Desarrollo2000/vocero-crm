import { describe, expect, it } from "vitest";
import {
  fillBrand,
  HELP_HEADER,
  HELP_TOPICS,
  parseInline,
  ruleMb,
  visibleTopics,
  type HelpTopic,
} from "@/lib/help/topics";
import { WHATSAPP_OUTBOUND_FILES } from "@/lib/outbound-files";

/**
 * 031 — Textos de la guía. Lo que importa: que lo de un módulo apagado no
 * aparezca, que la marca se ponga sin romper los comodines de las respuestas
 * rápidas, y que la guía cite la pantalla de hoy (sin los «?» retirados).
 */

function allText(topics: HelpTopic[]): string {
  return JSON.stringify(topics);
}

describe("visibleTopics", () => {
  it("con la agenda apagada no hay tema de citas", () => {
    const ids = visibleTopics({ agenda: false, channels: ["whatsapp"] }).map((t) => t.id);
    expect(ids).not.toContain("citas");
    expect(ids).toContain("plantillas");
  });

  it("con la agenda encendida sí", () => {
    const ids = visibleTopics({ agenda: true, channels: ["whatsapp"] }).map((t) => t.id);
    expect(ids).toContain("citas");
  });

  it("Seguimiento está con o sin agenda (no depende de un módulo)", () => {
    for (const agenda of [false, true]) {
      const ids = visibleTopics({ agenda, channels: ["whatsapp"] }).map((t) => t.id);
      expect(ids).toContain("seguimiento");
    }
  });

  it("sin agenda, Seguimiento no habla de citas (topics.ts no condiciona bloques por agenda)", () => {
    const seguimiento = visibleTopics({ agenda: false, channels: ["whatsapp"] }).find(
      (t) => t.id === "seguimiento"
    );
    expect(JSON.stringify(seguimiento)).not.toMatch(/[Cc]ita/);
  });

  it("Contactos está con o sin agenda; sus párrafos de canal, solo con el canal", () => {
    for (const agenda of [false, true]) {
      const ids = visibleTopics({ agenda, channels: ["whatsapp"] }).map((t) => t.id);
      expect(ids).toContain("contactos");
    }
    const soloWa = visibleTopics({ agenda: false, channels: ["whatsapp"] }).find((t) => t.id === "contactos");
    expect(JSON.stringify(soloWa)).not.toMatch(/Instagram|Messenger|canalesMeta/);
    expect(JSON.stringify(soloWa)).not.toMatch(/[Cc]ita/);
    const conIg = visibleTopics({ agenda: false, channels: ["whatsapp", "instagram"] }).find((t) => t.id === "contactos");
    expect(conIg?.bloques.some((b) => b.titulo === "¿Y en Instagram?")).toBe(true);
  });

  it("solo WhatsApp: sin párrafos de Instagram ni Messenger", () => {
    const text = allText(visibleTopics({ agenda: true, channels: new Set(["whatsapp"]) }));
    expect(text).not.toMatch(/Instagram|Messenger|canalesMeta/);
  });

  it("con Instagram: sus párrafos, sin los de Messenger", () => {
    const topics = visibleTopics({ agenda: false, channels: ["whatsapp", "instagram"] });
    const text = allText(topics);
    expect(text).toContain("**Instagram:**");
    expect(text).not.toContain("Messenger");
    const ventana = topics.find((t) => t.id === "ventana-24h");
    expect(ventana?.bloques.some((b) => b.titulo === "En Instagram")).toBe(true);
  });

  it("con los dos canales, el párrafo de la ventana los nombra a ambos", () => {
    const topics = visibleTopics({
      agenda: false,
      channels: ["whatsapp", "instagram", "messenger"],
    });
    const ventana = topics.find((t) => t.id === "ventana-24h");
    expect(ventana?.bloques.some((b) => b.titulo === "En Instagram y Messenger")).toBe(true);
    expect(allText(topics)).toContain("**Messenger:**");
  });

  it("no altera la lista original", () => {
    visibleTopics({ agenda: false, channels: [] });
    expect(HELP_TOPICS.some((t) => t.id === "citas")).toBe(true);
  });
});

describe("fillBrand", () => {
  it("pone el nombre de la instancia", () => {
    expect(fillBrand("Guía rápida de {negocio}", "Bers")).toBe("Guía rápida de Bers");
  });

  it("no toca el comodín {{negocio}} de las respuestas rápidas", () => {
    expect(fillBrand("`{{negocio}}` por {negocio}.", "Bers")).toBe("`{{negocio}}` por Bers.");
  });

  it("un nombre con $ se pone literal", () => {
    expect(fillBrand("{negocio}", "Casa $1")).toBe("Casa $1");
  });
});

describe("temas", () => {
  const ids = new Set(HELP_TOPICS.map((t) => t.id));

  it("los ids de los temas son únicos", () => {
    expect(ids.size).toBe(HELP_TOPICS.length);
  });

  it("cada tema tiene antetítulo, resumen e intro (índice y artículo)", () => {
    for (const t of HELP_TOPICS) {
      expect(t.antetitulo.trim(), t.id).not.toBe("");
      expect(t.resumen.trim(), t.id).not.toBe("");
      expect(t.intro.trim(), t.id).not.toBe("");
    }
  });

  it("ya no habla de los botones «?» ni de la UI anterior", () => {
    const text = JSON.stringify({ HELP_HEADER, HELP_TOPICS });
    expect(text).not.toContain("botones **?**");
    expect(text).not.toContain("Ventana abierta · quedan");
    expect(text).not.toContain("Valor de {{1}}");
    expect(text).not.toContain("Elige una plantilla…");
    expect(text).not.toContain("La ventana de 24 horas está cerrada.");
    expect(text).not.toContain("**clip**");
    // 032 — rótulos que cambiaron en Citas.
    expect(text).not.toContain("Sin asignar");
    expect(text).not.toContain("Mostrar pruebas");
    expect(text).not.toContain("«Manual»");
    // 032 fase B — Contactos ya no suma archivados ni inicia con un selector.
    expect(text).not.toContain("Ver archivados");
    expect(text).not.toContain("Iniciar conversación");
  });

  it("Seguimiento va junto a «¿Qué chats me tocan?» y cada tema trae su captura", () => {
    const order = HELP_TOPICS.map((t) => t.id);
    expect(order.indexOf("seguimiento")).toBe(order.indexOf("mis-chats") + 1);
    expect(HELP_TOPICS.find((t) => t.id === "seguimiento")?.captura).toEqual(["seguimiento.png"]);
    expect(HELP_TOPICS.find((t) => t.id === "citas")?.captura).toEqual(["cita.png", "citas.png"]);
    // 032 fase B — Contactos, justo después de Seguimiento.
    expect(order.indexOf("contactos")).toBe(order.indexOf("seguimiento") + 1);
    expect(HELP_TOPICS.find((t) => t.id === "contactos")?.captura).toEqual(["contactos.png"]);
    // 032 fase C — Catálogo: el panel del chat y la pantalla del menú.
    expect(HELP_TOPICS.find((t) => t.id === "catalogo")?.captura).toEqual(["catalogo.png", "catalogo-atajos.png"]);
    // 035 — Recordatorios, justo después de Contactos: el diálogo, Pendientes y la campana.
    expect(order.indexOf("recordatorios")).toBe(order.indexOf("contactos") + 1);
    expect(HELP_TOPICS.find((t) => t.id === "recordatorios")?.captura).toEqual([
      "recordarme.png",
      "pendientes.png",
      "avisos.png",
    ]);
  });

  it("032 fase C — el tema del catálogo es para vendedores (nada del Propietario ni de Reportes)", () => {
    const text = JSON.stringify(HELP_TOPICS.find((t) => t.id === "catalogo"));
    // Esos rótulos solo los ve el Propietario en «Catálogo».
    for (const ownerOnly of ["Le falta", "Listo para mandar", "Crear atajos", "Nuevo producto"]) {
      expect(text, ownerOnly).not.toContain(ownerOnly);
    }
    expect(text).toContain("pídele al propietario");
    // Reportes es solo del Propietario: ningún tema de la guía lo menciona.
    expect(JSON.stringify(HELP_TOPICS)).not.toMatch(/Reportes|reporte/);
  });

  it("no le presenta al vendedor lo que solo hace el Propietario", () => {
    const text = JSON.stringify(
      HELP_TOPICS.filter((t) => t.id === "seguimiento" || t.id === "citas" || t.id === "contactos")
    );
    expect(text).not.toContain("Gestionar etapas");
    expect(text).not.toContain("Mostrar citas del Laboratorio");
    expect(text).not.toContain("«Asignar»");
  });

  it("cita las etiquetas de la pantalla nueva", () => {
    const text = JSON.stringify(HELP_TOPICS);
    for (const label of [
      "«Para escribirle a …, usa un mensaje aprobado»",
      "«Elige el mensaje»",
      "«Completa los espacios»",
      "«Enviar plantilla»",
      "«Puedes escribirle libremente … más»",
      "«Adjuntar»",
      "«¿Qué quieres mandar?»",
      "«Catálogo»",
      "«Tomar»",
      "«Esto es lo que te toca ahora:»",
      "«Atender yo»",
      "«Devolver a la IA»",
      "«Sí, atiendo yo»",
      "«No, que siga»",
      "«Responde la IA»",
      // 032 — Seguimiento
      "«Mis clientes»",
      "«Sin tomar»",
      "«Todos»",
      "«Tomar y responder»",
      "«Retomar con plantilla»",
      "«Poner monto»",
      "«Capturar monto»",
      "«Lo atiende …»",
      "«¿Por qué se perdió?»",
      // 032 — Citas
      "«¿Cómo le fue a …?»",
      "«Sí, llegó»",
      "«No asistió»",
      "«Reprogramar»",
      "«Tomarla»",
      "«Mías»",
      "«Sin vendedor»",
      "«Todas»",
      "«Bloquear un horario»",
      "«La agendó una persona»",
      // 032 — Contactos
      "«Activos»",
      "«Archivados»",
      "«Abrir chat»",
      "«Escribir primero»",
      "«Enviar y abrir el chat»",
      "«Archivar»",
      "«Deshacer»",
      "«Desarchivar»",
      "«Nuevo contacto»",
      "«Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado»",
      "«Sin teléfono: no hay a dónde mandarle el primer mensaje»",
      "«No se pudieron cargar los contactos.»",
      // 032 fase C — Catálogo
      "«Para mandarle un producto a un cliente:»",
      "«Copiar»",
      "«Copiado»",
      "«Pausado: no se puede mandar»",
      "«Sin fotos todavía: pídele al propietario que las suba.»",
      "«Sin ficha PDF»",
      "«Sin atajo todavía»",
      "«No se pudo copiar: escribe … en el chat.»",
      "«Todavía no hay productos»",
      "«No se puede mandar por aquí: …»",
    ]) {
      expect(text, label).toContain(label);
    }
  });
});

describe("límites de archivos contra outbound-files.ts", () => {
  it("la tabla de WhatsApp sale de las reglas del canal", () => {
    const archivos = HELP_TOPICS.find((t) => t.id === "archivos");
    const tabla = archivos?.bloques.find((b) => b.tipo === "tabla");
    expect(tabla?.tipo).toBe("tabla");
    if (tabla?.tipo !== "tabla") return;
    const mb = Object.fromEntries(tabla.filas.map((f) => [f[0], f[2]]));
    expect(mb).toEqual({
      Fotos: `${ruleMb(WHATSAPP_OUTBOUND_FILES, "image")} MB`,
      Documentos: `${ruleMb(WHATSAPP_OUTBOUND_FILES, "document")} MB`,
      Audio: `${ruleMb(WHATSAPP_OUTBOUND_FILES, "audio")} MB`,
      Video: `${ruleMb(WHATSAPP_OUTBOUND_FILES, "video")} MB`,
    });
    // Y coincide con lo que dice contenido.md hoy.
    expect(mb).toEqual({ Fotos: "5 MB", Documentos: "100 MB", Audio: "16 MB", Video: "16 MB" });
  });

  it("los párrafos de Instagram y Messenger citan sus topes reales", () => {
    const text = allText(
      visibleTopics({ agenda: false, channels: ["instagram", "messenger"] })
    );
    expect(text).toContain("fotos 8 MB");
    expect(text).toContain("video 25 MB");
    expect(text).toContain("**Messenger:** hasta 25 MB.");
  });
});

describe("parseInline", () => {
  it("distingue negrita, cursiva, código y etiquetas de pantalla", () => {
    expect(parseInline("Haz clic en «Tomar» y **listo** con `/horario` *(opcional)*.")).toEqual([
      { tipo: "texto", valor: "Haz clic en " },
      { tipo: "etiqueta", valor: "Tomar" },
      { tipo: "texto", valor: " y " },
      { tipo: "negrita", valor: "listo" },
      { tipo: "texto", valor: " con " },
      { tipo: "codigo", valor: "/horario" },
      { tipo: "texto", valor: " " },
      { tipo: "cursiva", valor: "(opcional)" },
      { tipo: "texto", valor: "." },
    ]);
  });

  it("texto sin marcado queda entero", () => {
    expect(parseInline("Envía.")).toEqual([{ tipo: "texto", valor: "Envía." }]);
  });
});
