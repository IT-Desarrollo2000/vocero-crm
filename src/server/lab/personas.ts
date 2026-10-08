/**
 * Las 6 personas GUIONADAS del Laboratorio (FR-030). El cliente simulado no
 * usa LLM: son secuencias fijas — determinismo total del lado del cliente.
 * El agente que responde es el REAL (mismo pipeline de US3).
 */

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Teléfono sintético estable (jamás un número real). */
  phone: string;
  contactName: string;
  script: string[];
};

export const PERSONAS: Persona[] = [
  {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description:
      "Ya eligió modelo y quiere apartarlo: precio de lista, autonomía CLTC y pase a asesor al comprar.",
    phone: "5210000000001",
    contactName: "[Prueba] Comprador decidido",
    script: [
      "Hola, buenas tardes",
      "Me interesa el Leapmotor T03, ¿en cuánto está?",
      "¿Qué autonomía tiene? Hago unos 60 km diarios aquí en Villahermosa",
      "Me convence, quiero comprar el T03. ¿Cómo le hago para apartarlo?",
    ],
  },
  {
    key: "pregunton_precios",
    label: "Preguntón de precios",
    description:
      "Compara precios y pide mensualidades y descuentos: no debe inventar cifras.",
    phone: "5210000000002",
    contactName: "[Prueba] Preguntón de precios",
    script: [
      "Hola, ¿cuánto cuesta el Macaron?",
      "¿Y el Bingo Plus?",
      "¿Cuánto me quedaría la mensualidad dando 20% de enganche?",
      "¿Me hacen algún descuento si pago de contado?",
      "Ok, lo voy a pensar",
    ],
  },
  {
    key: "cliente_enojado",
    label: "Cliente enojado",
    description:
      "Dueño molesto por una falla de batería: reconocer la molestia y escalar el reclamo.",
    phone: "5210000000003",
    contactName: "[Prueba] Cliente enojado",
    script: [
      "Oigan, esto es el colmo",
      "Compré un Bingo hace 3 meses y ya no quiere cargar, me marca falla de batería",
      "¿Me van a responder o qué? Quiero una solución YA",
      "Pues más les vale, porque me costó mucho dinero",
    ],
  },
  {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description:
      "Pregunta datos que el conocimiento no cubre (seguridad, equipamiento): no inventar y escalar a la segunda.",
    phone: "5210000000004",
    contactName: "[Prueba] Fuera del conocimiento",
    script: [
      "Hola, una pregunta",
      "¿Cuántas bolsas de aire trae el Wuling Bingo?",
      "¿Y qué calificación de seguridad Latin NCAP tiene?",
      "¿El Nammi 01 trae Apple CarPlay?",
    ],
  },
  {
    key: "pide_humano",
    label: "Pide un humano",
    description:
      "Tras una duda de carga en casa, pide una persona: debe escalar de inmediato.",
    phone: "5210000000005",
    contactName: "[Prueba] Pide humano",
    script: [
      "Hola",
      "Tengo dudas sobre cómo cargar el auto en mi casa",
      "La verdad prefiero que me atienda una persona, quiero hablar con un humano",
      "Gracias",
    ],
  },
  {
    key: "errores_modismos",
    label: "Errores y modismos",
    description:
      "Escribe con faltas y modismos tabasqueños; objeciones de batería, calor e inundaciones.",
    phone: "5210000000006",
    contactName: "[Prueba] Errores y modismos",
    script: [
      "ke onda, si es cierto q los electricos no gastan gasolina?",
      "y cuanto aguanta la bateria, no se acaba rapido con el calor de aki?",
      "oiga y si se mete al agua cuando se inunda la calle no le pasa nada?",
      "va, orita paso a verlos, sale",
    ],
  },
];

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, p.label])
);
