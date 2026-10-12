/**
 * Las 7 personas GUIONADAS del Laboratorio (FR-030). El cliente simulado no
 * usa LLM: son secuencias fijas — determinismo total del lado del cliente.
 * El agente que responde es el REAL (mismo pipeline de US3).
 *
 * 08 — Desde el contrato 08-0 estas personas son el set de semilla `autos`
 * (D-08-01); cada organización tendrá las suyas en `lab_persona`.
 */

import { createHash } from "node:crypto";
import {
  LAB_SYNTHETIC_PHONE_PREFIX,
  type LabExpectFichaRule,
  type LabPersonaSnapshot,
  type LabSeedSet,
} from "@/lib/lab";

/**
 * 03 — Estado inicial del contacto sintético en cada caso: el runner lo
 * reinicia a esto (`resetTestContact`) antes del guion. Sin semilla, notas y
 * ficha quedan vacías.
 */
export type PersonaSeed = {
  ficha?: Record<string, string | number | boolean>;
  notes?: string;
  name?: string;
};

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Teléfono sintético estable (jamás un número real). */
  phone: string;
  contactName: string;
  script: string[];
  seed?: PersonaSeed;
  /**
   * 04 — Qué debe quedar en la ficha del contacto sintético al terminar el
   * caso (clave → patrón del valor). Chequeo determinista e informativo
   * (`agent_test_case.ficha_check`), fuera del score del juez. Solo cuenta
   * con las claves que la organización tiene definidas y que llena el agente.
   */
  expectFicha?: Record<string, RegExp>;
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
    expectFicha: {
      modelo_interes: /t03/i,
      ciudad: /villahermosa/i,
    },
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
    expectFicha: { modelo_interes: /macaron|bingo/i },
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
  {
    // 03 — Solo se responde bien USANDO el contexto (ficha + notas). No
    // ejercita "recurrente" ni etapa: los contactos del Laboratorio no tienen
    // lead.
    key: "cliente_que_regresa",
    label: "Cliente que regresa",
    description:
      "Ya había preguntado antes (ficha y notas sembradas): debe reconocer el T03 y el financiamiento sin volver a preguntarlos y no inventar mensualidades fuera del conocimiento.",
    phone: "5210000000007",
    contactName: "[Prueba] Cliente que regresa",
    seed: {
      ficha: {
        modelo_interes: "Leapmotor T03",
        ciudad: "Villahermosa",
        forma_pago: "financiamiento",
      },
      notes: "[IA] Preguntó por el T03, maneja 60 km diarios",
    },
    script: [
      "Hola, ya regresé 👋",
      "¿Siguen teniendo el que les pregunté?",
      "¿Y cuánto quedaría la mensualidad como les dije?",
      "Va, ¿cuándo puedo pasar a verlo?",
    ],
  },
];

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, p.label])
);

/* ============================================================
 * 08 — Laboratorio por cliente (contrato 08-0)
 *
 * Este módulo sigue SIN tocar la BD: lo importa `bot/ficha.ts` para la guarda
 * de `resetTestContact`. Lo que lee/escribe `lab_persona` vive en
 * `persona-store.ts`.
 * ============================================================ */

const SYNTHETIC_PHONE_RE = new RegExp(`^${LAB_SYNTHETIC_PHONE_PREFIX}\\d{5}$`);

/**
 * ¿Es un teléfono sintético del Laboratorio (`52100000` + 5 dígitos)? Vale
 * para semillas, personas personalizadas y archivadas: no depende de ningún
 * set de personas ni de la BD.
 */
export function isSyntheticLabPhone(value: string | null | undefined): boolean {
  return !!value && SYNTHETIC_PHONE_RE.test(value);
}

/** Teléfono sintético de la secuencia `n` (1..99999). */
export function syntheticLabPhone(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99_999) {
    throw new RangeError(`secuencia de teléfono sintético fuera de rango: ${n}`);
  }
  return `${LAB_SYNTHETIC_PHONE_PREFIX}${String(n).padStart(5, "0")}`;
}

/**
 * Persona tal como la usa el runner (de BD o de un set en código). Mismos
 * campos que `Persona` con los nombres de `lab_persona`; `expectFicha` ya
 * compilado a RegExp.
 */
export type LabPersona = {
  /** `lab_persona.id`; `null` = persona del set en código. */
  id: string | null;
  key: string;
  name: string;
  objetivo: string;
  rasgos: string | null;
  guion: string[];
  criteriosExito: string | null;
  contactName: string;
  phone: string;
  seed?: PersonaSeed;
  expectFicha?: Record<string, RegExp>;
  active: boolean;
  position: number;
};

/** Lleva una persona del set en código a la forma de `LabPersona`. */
export function fromCodePersona(p: Persona, position = 0): LabPersona {
  return {
    id: null,
    key: p.key,
    name: p.label,
    objetivo: p.description,
    rasgos: null,
    guion: [...p.script],
    criteriosExito: null,
    contactName: p.contactName,
    phone: p.phone,
    seed: p.seed,
    expectFicha: p.expectFicha,
    active: true,
    position,
  };
}

/** `Record<clave, RegExp>` → reglas jsonb (`lab_persona.expect_ficha`). */
export function serializeExpectFicha(
  expect: Record<string, RegExp> | undefined
): LabExpectFichaRule[] {
  return Object.entries(expect ?? {}).map(([key, re]) => ({
    key,
    pattern: re.source,
    flags: re.flags,
  }));
}

/** Reglas jsonb → `Record<clave, RegExp>`. Una regla inválida se descarta. */
export function compileExpectFicha(
  rules: readonly LabExpectFichaRule[] | null | undefined
): Record<string, RegExp> | undefined {
  const out: Record<string, RegExp> = {};
  for (const r of rules ?? []) {
    try {
      out[r.key] = new RegExp(r.pattern, r.flags);
    } catch {
      // Patrón inválido: el chequeo de ficha es informativo, no tumba el caso.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Hash de lo que cambia la evaluación de una persona (delta comparable). */
export function personaHash(p: LabPersona): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        p.guion,
        p.objetivo,
        p.rasgos,
        p.criteriosExito,
        p.seed ?? null,
      ])
    )
    .digest("hex");
}

/** `agent_test_case.persona_snapshot` de una persona. */
export function personaSnapshot(p: LabPersona): LabPersonaSnapshot {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    objetivo: p.objetivo,
    rasgos: p.rasgos,
    guion: [...p.guion],
    criteriosExito: p.criteriosExito,
    contactName: p.contactName,
    phone: p.phone,
    seed: p.seed ?? null,
    expectFicha: serializeExpectFicha(p.expectFicha),
    hash: personaHash(p),
  };
}

/**
 * Set neutro (D-08-01) para organizaciones nuevas: mismas claves y teléfonos
 * que el set de autos, sin productos concretos. Sin `expectFicha`: las claves
 * de la ficha son de cada negocio.
 */
export const PERSONAS_NEUTRO: Persona[] = [
  {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description:
      "Ya sabe qué quiere y pregunta cómo comprar: datos del conocimiento y pase a un asesor para cerrar.",
    phone: "5210000000001",
    contactName: "[Prueba] Comprador decidido",
    script: [
      "Hola, buenas tardes",
      "Me interesa su producto principal, ¿qué precio tiene?",
      "¿Qué incluye exactamente?",
      "Me convence, quiero comprarlo. ¿Cómo le hago?",
    ],
  },
  {
    key: "pregunton_precios",
    label: "Preguntón de precios",
    description:
      "Compara precios, pide pagos a plazos y descuentos: no debe inventar cifras.",
    phone: "5210000000002",
    contactName: "[Prueba] Preguntón de precios",
    script: [
      "Hola, ¿cuánto cuesta lo más económico que tienen?",
      "¿Y la opción más completa?",
      "¿Se puede pagar a meses? ¿Cuánto quedaría cada pago?",
      "¿Me hacen algún descuento si pago de contado?",
      "Ok, lo voy a pensar",
    ],
  },
  {
    key: "cliente_enojado",
    label: "Cliente enojado",
    description:
      "Cliente molesto por un problema con su compra: reconocer la molestia y escalar el reclamo.",
    phone: "5210000000003",
    contactName: "[Prueba] Cliente enojado",
    script: [
      "Oigan, esto es el colmo",
      "Les compré hace un mes y ya me falló, nadie me resuelve",
      "¿Me van a responder o qué? Quiero una solución YA",
      "Pues más les vale, porque me costó mucho dinero",
    ],
  },
  {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description:
      "Pregunta datos que el conocimiento no cubre (garantías, devoluciones, detalles técnicos): no inventar y escalar si insiste.",
    phone: "5210000000004",
    contactName: "[Prueba] Fuera del conocimiento",
    script: [
      "Hola, una pregunta",
      "¿Qué garantía tiene lo que venden?",
      "¿Y si no me gusta lo puedo devolver?",
      "¿Hacen envíos a otros estados?",
    ],
  },
  {
    key: "pide_humano",
    label: "Pide un humano",
    description:
      "Tras una duda, pide hablar con una persona: debe escalar de inmediato.",
    phone: "5210000000005",
    contactName: "[Prueba] Pide humano",
    script: [
      "Hola",
      "Tengo una duda sobre mi pedido",
      "La verdad prefiero que me atienda una persona, quiero hablar con un humano",
      "Gracias",
    ],
  },
  {
    key: "errores_modismos",
    label: "Errores y modismos",
    description:
      "Escribe con faltas de ortografía y modismos: el agente debe entender y responder claro.",
    phone: "5210000000006",
    contactName: "[Prueba] Errores y modismos",
    script: [
      "ke onda, q venden aki?",
      "y cuanto sale, no esta muy caro?",
      "oiga y si lo pido oi cuando me llega?",
      "va, orita les escribo, sale",
    ],
  },
  {
    key: "cliente_que_regresa",
    label: "Cliente que regresa",
    description:
      "Ya había escrito antes (notas sembradas): debe retomar lo que pidió sin volver a preguntarlo y no inventar precios fuera del conocimiento.",
    phone: "5210000000007",
    contactName: "[Prueba] Cliente que regresa",
    seed: { notes: "[IA] Preguntó por precios y formas de pago" },
    script: [
      "Hola, ya regresé 👋",
      "¿Siguen teniendo lo que les pregunté?",
      "¿Y cómo quedaría el pago como les dije?",
      "Va, ¿cuándo puedo pasar?",
    ],
  },
];

/** Set de autos (D-08-01): las personas actuales, para orgs con corridas. */
export const PERSONAS_AUTOS: Persona[] = PERSONAS;

/** Personas de un set de semilla. */
export function seedPersonas(set: LabSeedSet): Persona[] {
  return set === "autos" ? PERSONAS_AUTOS : PERSONAS_NEUTRO;
}

/** D-08-01: con alguna corrida previa → `autos`; org nueva → `neutro`. */
export function chooseSeedSet(hasRuns: boolean): LabSeedSet {
  return hasRuns ? "autos" : "neutro";
}

/**
 * Etiqueta para corridas sin `persona_snapshot` (anteriores a 08): la del
 * set de autos, luego la del neutro, luego la key.
 */
export function legacyPersonaLabel(key: string): string {
  return (
    PERSONA_LABELS[key] ??
    PERSONAS_NEUTRO.find((p) => p.key === key)?.label ??
    key
  );
}
