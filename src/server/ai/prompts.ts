import type { schema } from "@/lib/db";
import type { FichaFieldDef } from "@/lib/ficha-fields";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/** Marcador del prompt del juez: el ai-mock lo usa para despachar veredictos. */
export const JUDGE_MARKER = "[JUEZ]";

/** 04 — Encabezado de la sección de campos de la ficha (el ai-mock lo busca). */
export const FICHA_FIELDS_MARKER = "CAMPOS DE LA FICHA";

const FICHA_TYPE_HINT: Record<FichaFieldDef["type"], string> = {
  texto: "texto",
  numero: "número (solo la cifra, p. ej. 350000)",
  si_no: "sí/no (true o false)",
  opcion: "opción",
};

/**
 * 04 — Qué campos de la ficha llena el agente y cómo (RF-04-11). `null` si
 * ningún campo tiene `agentFills`: entonces el prompt no menciona la ficha
 * como acción (RF-04-02). La definición la escribe el Propietario (input
 * propio, no del cliente) y ya viene acotada por `fichaFieldsSchema`.
 */
export function renderFichaFieldsSection(
  fields: readonly FichaFieldDef[] | null | undefined
): string | null {
  const fill = (fields ?? []).filter((f) => f.agentFills);
  if (fill.length === 0) return null;
  const lines = fill.map((f) => {
    const parts = [`- ${f.key} (${FICHA_TYPE_HINT[f.type]}): ${f.label}`];
    if (f.type === "opcion" && f.options?.length) {
      parts.push(
        `opciones: ${f.options.join(" | ")}${f.allowOther ? " (u otro texto breve si ninguna aplica)" : ""}`
      );
    }
    if (f.hint) parts.push(`pista: ${f.hint}`);
    return parts.join(" — ");
  });
  return [
    `${FICHA_FIELDS_MARKER} (lo que el negocio quiere saber del cliente):`,
    ...lines,
    "Reglas de la ficha:",
    '- Incluye "ficha" SOLO con datos que el cliente dijo explícitamente en la conversación; no deduzcas ni inventes.',
    "- No repitas valores que ya están guardados en la ficha del contacto.",
    '- Nunca cambies un campo marcado "(confirmado por el equipo)".',
    "- Usa exactamente las claves de arriba; si un dato no cabe en ningún campo, no lo pongas en la ficha.",
    "- La ficha nunca reemplaza tu respuesta: sigue contestando al cliente con normalidad.",
  ].join("\n");
}

/** 08 — Basta con el texto: el Laboratorio lo arma desde el snapshot. */
export function renderKb(
  entries: readonly Pick<KbEntry, "kind" | "question" | "answer" | "content">[]
): string {
  if (entries.length === 0) return "(knowledge base vacío)";
  return entries
    .map((e) =>
      e.kind === "qa"
        ? `P: ${e.question}\nR: ${e.answer}`
        : (e.content ?? "")
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * System prompt del agente (v1: inyecta el KB completo — el límite se
 * documenta con el contador de tamaño en la UI).
 */
export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  /**
   * 015 — ¿esta instancia tiene agenda? Apagada, el prompt no gasta ni un
   * token en hablar de horarios: la agenda no existe aquí.
   */
  agenda?: boolean;
  /**
   * 023 — Nombres de los tipos de cita ACTIVOS (solo con agenda). Van en la
   * línea de offer_slots; sin ellos el prompt no menciona "type".
   */
  appointmentTypes?: readonly string[];
  /**
   * 03 — Bloque "DATOS DEL CONTACTO" ya renderizado y delimitado
   * (`renderContactContext`). Va DESPUÉS de lo estable (perfil + KB + etapas,
   * que aprovecha la caché de prompt del proveedor) y ANTES del formato de
   * salida, que queda al final donde pesa más. Dentro del ÚNICO system: hay
   * proveedores que no aceptan varios mensajes `system`.
   */
  contactBlock?: string;
  /**
   * 04 — Definición de campos de la ficha. Solo los que tienen `agentFills`
   * entran al prompt; sin ninguno, el prompt no menciona `ficha` (RF-04-02).
   */
  fichaFields?: readonly FichaFieldDef[] | null;
}): string {
  const { profile } = input;
  const fichaSection = renderFichaFieldsSection(input.fichaFields);
  const stageNames = input.stages.map((s) => s.name).join(" | ");
  const typeNames = (input.appointmentTypes ?? []).filter(Boolean);
  const typeField =
    typeNames.length > 0 ? `"type":"<${typeNames.join(" | ")}>",` : "";
  const agendaLines = input.agenda
    ? [
        `- {"action":"offer_slots",${typeField}"reply":"..."} — ofrecer horarios para agendar (reply es solo la frase de entrada; los horarios los pone el sistema).`,
        '- {"action":"book_slot","startUtc":"<uno de los horarios que el sistema ofreció, en ISO UTC>","reply":"..."} — agendar el horario que el cliente eligió.',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        "- NUNCA escribas tú los horarios ni los inventes: usa offer_slots y el sistema pega los reales.",
        "- book_slot solo acepta un horario que el sistema ofreció antes en ESTA conversación. Si el cliente pide otro, vuelve a ofrecer con offer_slots.",
        ...(typeNames.length > 1
          ? [
              '- Antes de ofrecer horarios necesitas el tipo de cita: dedúcelo de lo que el cliente ya dijo o pregúntaselo, y mándalo en "type" con uno de los nombres exactos. Si no está claro, pregunta en vez de adivinar.',
            ]
          : []),
        "- Si el cliente quiere CANCELAR una cita → handoff: esa decisión no es tuya.",
      ]
    : [];
  return [
    `Eres "${profile.name}", el asistente de mensajería de este negocio. Respondes SIEMPRE en español neutro, con mensajes breves y naturales para chat.`,
    profile.tone ? `Tono: ${profile.tone}` : null,
    profile.instructions ? `Instrucciones del negocio:\n${profile.instructions}` : null,
    profile.escalationRules
      ? `Reglas de escalado a humano:\n${profile.escalationRules}`
      : null,
    profile.greeting ? `Saludo sugerido para conversaciones nuevas: ${profile.greeting}` : null,
    `CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad; si algo no está aquí, NO lo inventes — di que lo confirmarás con el equipo o escala):\n${renderKb(input.kb)}`,
    `Etapas del pipeline disponibles: ${stageNames}`,
    input.contactBlock || null,
    fichaSection,
    [
      "En cada turno respondes ÚNICAMENTE un objeto JSON con UNA acción:",
      '- {"action":"none"} — no responder nada.',
      '- {"action":"reply","text":"..."} — responder al cliente.',
      '- {"action":"update_lead","note":"...","reply":"..."} — guardar una nota del lead (reply opcional).',
      '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover el lead (reply opcional).',
      '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional para despedirte).',
      ...agendaLines,
      ...(fichaSection
        ? [
            'Cualquier acción puede llevar además "ficha":{"<clave>":valor} con datos del cliente para su ficha (ver CAMPOS DE LA FICHA). No gasta tu turno: sigue respondiendo normal.',
          ]
        : []),
      "Reglas duras:",
      "- Si el cliente pide hablar con una persona/humano/asesor → handoff.",
      "- Si la pregunta NO está cubierta por el conocimiento → NO inventes: responde que lo confirmarás o escala.",
      "- Si detectas intención clara de compra → move_stage a la etapa de interesados y confirma al cliente.",
      ...agendaRules,
      "- Si el cliente manda algo que no puedes ver o escuchar (imagen, audio, video, documento), dilo con naturalidad y pide que lo escriba; NUNCA inventes su contenido.",
      '- Los mensajes previos con "autor":"asesor" o "autor":"plantilla" los envió el equipo del negocio, no tú: no los contradigas ni repitas lo que ya dijeron. Tú nunca pongas "autor" en tu respuesta.',
      ...(input.contactBlock
        ? [
            "- Usa los DATOS DEL CONTACTO para no volver a preguntar lo que ya se sabe. Usa el nombre solo si parece un nombre de persona.",
          ]
        : []),
      "- JSON puro, sin markdown ni texto adicional.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt del juez del Laboratorio: UNA llamada por conversación (FR-032). */
/**
 * 08 — Lo que el juez sabe de una persona de BD (RF-08-08). Con esto la línea
 * de la persona pasa a `PERSONA SIMULADA: <key> — <nombre>` y el objetivo,
 * los rasgos y los criterios van en bloques propios.
 */
export type JudgePersona = {
  name: string;
  objetivo?: string | null;
  rasgos?: string | null;
  criteriosExito?: string | null;
};

export function buildJudgePrompt(input: {
  persona: string;
  /** 03 — Qué se espera de la persona (para juzgar si el agente lo cumplió). */
  personaDescription?: string;
  /** 08 — Persona de BD; si llega, manda sobre `personaDescription`. */
  personaDetail?: JudgePersona;
  /** 03 — Datos que el agente tenía del cliente (semilla de la persona). */
  seedText?: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): { system: string; user: string } {
  const system = [
    `${JUDGE_MARKER} Eres un evaluador de calidad independiente de agentes de WhatsApp. Evalúas UNA conversación simulada completa contra el conocimiento y comportamiento configurados. Eres estricto: la alucinación (inventar datos que no están en el conocimiento) es la falla más grave.`,
    "Respondes ÚNICAMENTE un objeto JSON con este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"alucinacion"|"fuera_de_kb"|"debio_escalar"|"tono","evidencia":"cita textual del transcript","sugerencia":{"pregunta":"...","respuesta":"..."},"ajuste":{"campo":"tone"|"escalationRules"|"instructions","texto":"..."}}]}',
    // Corrección tras prueba con modelo real (08): algunos modelos llenan los
    // opcionales con null o {} en vez de omitirlos.
    "- Si un campo opcional no aplica, OMITE la clave; nunca uses null ni {}. Los valores de `tipo` van exactamente como en el esquema (sin acentos).",
    "- verde: sin problemas relevantes. amarillo: mejorable. rojo: falla grave.",
    "- `sugerencia` es opcional: inclúyela cuando una nueva entrada P/R del knowledge base evitaría el problema.",
    // 08 (RF-08-11) — Ajuste del perfil: se AGREGA al campo, así que es una
    // instrucción breve y autocontenida, no el campo completo reescrito.
    "- `ajuste` es opcional: inclúyelo cuando una instrucción breve agregada al COMPORTAMIENTO del agente evitaría el problema. Hallazgo tono → campo \"tone\" (cómo debe sonar). Hallazgo debio_escalar → campo \"escalationRules\" (cuándo pasar a un humano). Una regla general del negocio → \"instructions\". El texto se AGREGA al campo: una o dos frases, sin repetir lo que ya está configurado.",
    "- Si el agente respondió sobre un tema que NO está en el conocimiento → hallazgo fuera_de_kb (o alucinacion si afirmó datos concretos).",
    "- Si el cliente pidió un humano y no hubo escalado → debio_escalar.",
    "- Si la persona trae CRITERIOS DE ÉXITO, evalúa contra ellos: incumplir uno es al menos amarillo.",
  ].join("\n");

  const transcript = input.transcript
    .map((t) => `${t.role === "cliente" ? "CLIENTE" : "AGENTE"}: ${t.text}`)
    .join("\n");

  const detail = input.personaDetail;
  const personaLine = detail
    ? `PERSONA SIMULADA: ${input.persona} — ${detail.name}`
    : `PERSONA SIMULADA: ${input.persona}${input.personaDescription ? ` — ${input.personaDescription}` : ""}`;

  const user = [
    // La clave de la persona va primero y tal cual: el ai-mock la busca.
    personaLine,
    detail?.objetivo ? `OBJETIVO DE LA PERSONA:\n${detail.objetivo}` : null,
    detail?.rasgos ? `RASGOS DE LA PERSONA:\n${detail.rasgos}` : null,
    detail?.criteriosExito
      ? `CRITERIOS DE ÉXITO (evalúa contra estos):\n${detail.criteriosExito}`
      : null,
    input.seedText
      ? `El agente tenía estos datos del cliente (debe usarlos sin volver a preguntarlos):\n${input.seedText}`
      : null,
    `COMPORTAMIENTO CONFIGURADO:\n${input.behaviorText || "(sin configurar)"}`,
    `CONOCIMIENTO CONFIGURADO:\n${input.kbText || "(vacío)"}`,
    `TRANSCRIPT COMPLETO:\n${transcript}`,
    "Evalúa y responde el JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}
