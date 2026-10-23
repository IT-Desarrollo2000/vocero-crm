import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { runAgentTurn } from "@/server/ai/pipeline";
import { renderKb, type JudgeHandoff } from "@/server/ai/prompts";
import { computeScore, judgeCase } from "@/server/lab/judge";
import {
  compileExpectFicha,
  personaSnapshot,
  type PersonaSeed,
} from "@/server/lab/personas";
import { ensureSeedPersonas, loadRunPersonas } from "@/server/lab/persona-store";
import { behaviorTextOf, loadConfigSnapshot } from "@/server/lab/snapshot";
import { resetTestContact } from "@/server/bot/ficha";
import { scoped } from "@/lib/db/tenant";
import type { FichaCheck, FichaFieldDef } from "@/lib/ficha-fields";
import {
  LAB_MAX_SCRIPT_MESSAGES,
  type LabConfigSnapshot,
  type LabPersonaSnapshot,
} from "@/lib/lab";
import { computeFichaCheck } from "@/server/lab/ficha-check";

/**
 * Runner del Laboratorio (FR-030/FR-034): corrida en segundo plano DENTRO del
 * proceso (sin cola externa), turnos secuenciales con debounce 0, timeout
 * global (`LAB_RUN_TIMEOUT_MS`, o escalado con la corrida: `runTimeoutMsFor`),
 * y lock de concurrencia
 * por índice parcial UNIQUE en BD (máx. 1 corrida `running` por organización).
 *
 * Cancelación cooperativa: al vencer el timeout se aborta la corrida y TODA
 * escritura/publicación del runner se chequea contra la señal antes de
 * hacerse. `runAgentTurn` y `chatJson` no aceptan señal, así que un turno ya
 * en vuelo termina (a lo sumo deja una respuesta más en su conversación de
 * prueba); después el runner no escribe nada más de esa corrida.
 *
 * Sandbox (FR-031): las conversaciones se crean con is_test=true; el pipeline
 * del agente persiste las respuestas sin tocar la API, y el sender real lanza
 * si algo intenta enviarlas.
 */

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Tope de setTimeout en Node: por encima dispara casi de inmediato. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * Espera tras abortar a que el runner salga solo (p.ej. que asiente una
 * escritura ya despachada) antes de `failRun`. No espera al LLM: si sigue
 * colgado, las compuertas le impiden escribir después.
 */
export const ABORT_GRACE_MS = 30_000;

/** `LAB_RUN_TIMEOUT_MS`: entero positivo en ms; inválido → 10 minutos. */
export function parseRunTimeoutMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return DEFAULT_RUN_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
    return DEFAULT_RUN_TIMEOUT_MS;
  }
  return ms;
}

/** 08 (D-08-03) — Presupuesto por mensaje del guion (turno del agente). */
export const RUN_TIMEOUT_PER_MESSAGE_MS = 15_000;
/** 08 (D-08-03) — Presupuesto fijo por caso (juez + contacto + ficha). */
export const RUN_TIMEOUT_PER_CASE_MS = 30_000;

/**
 * 08 (D-08-03) — Timeout de una corrida: `LAB_RUN_TIMEOUT_MS` si es válido
 * (manda siempre); si no, escala con la corrida:
 * `max(10 min, casos × (mensajes_max × 15 s + 30 s))`. Tope 10 personas × 8
 * mensajes ⇒ 25 min. Hoy (7 personas, ≤ 5 mensajes) ⇒ 12 min 15 s.
 * Lo usa `executeRun` con los casos y el guion más largo de la corrida.
 */
export function runTimeoutMsFor(
  raw: string | undefined,
  run: { cases: number; maxMessages: number }
): number {
  const value = raw?.trim();
  if (value && /^\d+$/.test(value)) {
    const ms = Number(value);
    if (Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMER_MS) return ms;
  }
  const scaled =
    Math.max(0, run.cases) *
    (Math.max(0, run.maxMessages) * RUN_TIMEOUT_PER_MESSAGE_MS +
      RUN_TIMEOUT_PER_CASE_MS);
  return Math.min(MAX_TIMER_MS, Math.max(DEFAULT_RUN_TIMEOUT_MS, scaled));
}

export class RunConflictError extends Error {}

/** Lo que la corrida necesita en memoria (sin releerlo de la BD). */
type RunPlan = {
  config: LabConfigSnapshot;
  /** Nº de casos: el `total` del progreso, también en `failRun`. */
  total: number;
  /** Guion más largo (ya topado a 8): escala el timeout (D-08-03). */
  maxMessages: number;
};

/**
 * 08 — Crea la corrida con las personas de la org (regla 4 del contrato):
 * siembra perezosa ANTES de insertar el run (D-08-01), personas activas o
 * las elegidas (`LabError` no_personas/unknown_persona), `config_snapshot`
 * + `persona_keys` en el INSERT del run y un caso por persona con su
 * `persona_snapshot`.
 */
export async function startRun(
  organizationId: string,
  personaKeys?: readonly string[]
): Promise<string> {
  const db = getDb();
  await ensureSeedPersonas(organizationId);
  const personas = await loadRunPersonas(organizationId, personaKeys);
  const config = await loadConfigSnapshot(organizationId, personas);

  let runId: string;
  try {
    const inserted = await db
      .insert(schema.agentTestRun)
      .values({
        id: newId("testRun"),
        organizationId,
        status: "running",
        configSnapshot: config,
        personaKeys: personas.map((p) => p.key),
      })
      .returning();
    runId = inserted[0]!.id;
  } catch (err) {
    // Violación del índice parcial UNIQUE → ya hay una corrida activa.
    if (isUniqueViolation(err)) {
      throw new RunConflictError("Ya hay una corrida en curso");
    }
    throw err;
  }

  await db.insert(schema.agentTestCase).values(
    personas.map((p) => ({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: p.key,
      personaSnapshot: personaSnapshot(p),
      status: "pending" as const,
    }))
  );

  const plan: RunPlan = {
    config,
    total: personas.length,
    maxMessages: Math.min(
      LAB_MAX_SCRIPT_MESSAGES,
      Math.max(0, ...personas.map((p) => p.guion.length))
    ),
  };

  // Fire-and-forget in-process: el POST regresa ya; el progreso va por SSE.
  void executeRun(runId, organizationId, plan).catch(async (err) => {
    console.error("[lab] corrida falló:", err);
    await failRun(runId, organizationId, String(err), plan.total);
  });

  return runId;
}

async function executeRun(
  runId: string,
  organizationId: string,
  plan: RunPlan
): Promise<void> {
  const timeoutMs = runTimeoutMsFor(process.env.LAB_RUN_TIMEOUT_MS, {
    cases: plan.total,
    maxMessages: plan.maxMessages,
  });
  const controller = new AbortController();
  const { signal } = controller;

  let onTimeout: () => void = () => {};
  const timedOut = new Promise<"timeout">((resolve) => {
    onTimeout = () => resolve("timeout");
  });
  const timer = setTimeout(() => {
    controller.abort(new Error(`timeout de ${timeoutMs} ms superado`));
    onTimeout();
  }, timeoutMs);

  const work = runAllCases(runId, organizationId, plan, signal);
  // Un rechazo tardío de la corrida abortada no debe quedar sin manejar.
  work.catch(() => {});

  try {
    const first = await Promise.race([
      work.then(() => "done" as const),
      timedOut,
    ]);
    if (first === "done") return;

    // Orden: abort (ya hecho) → esperar a que el runner salga, con tope →
    // cerrar el caso en curso → failRun. El run sigue `running` mientras
    // tanto: el candado UNIQUE no se libera ni la corrida se puede borrar.
    const settled = await settleWithin(work, ABORT_GRACE_MS);
    // Terminó justo antes de notar el abort: queda `done`, no se pisa.
    if (settled === "resolved") return;
    await closeRunningCases(runId);
    await failRun(runId, organizationId, String(signal.reason), plan.total);
  } catch (err) {
    // Fallo propio de la corrida (no timeout): se aborta igual por si algo
    // quedara en vuelo.
    controller.abort(err);
    await closeRunningCases(runId);
    await failRun(runId, organizationId, String(err), plan.total);
  } finally {
    clearTimeout(timer);
  }
}

/** Espera `work` hasta `ms`; el timer de la espera siempre se limpia. */
async function settleWithin(
  work: Promise<unknown>,
  ms: number
): Promise<"resolved" | "rejected" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => "resolved" as const,
        () => "rejected" as const
      ),
      cap,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * El caso interrumpido no puede quedar `running`: pasa a `judge_failed`
 * ("sin veredicto"), único estado terminal sin evaluación. Los que no
 * empezaron siguen `pending`.
 */
async function closeRunningCases(runId: string): Promise<void> {
  await getDb()
    .update(schema.agentTestCase)
    .set({ status: "judge_failed" })
    .where(
      and(
        eq(schema.agentTestCase.runId, runId),
        eq(schema.agentTestCase.status, "running")
      )
    );
}

/**
 * Persona tal como corre un caso: sale del `persona_snapshot` (no de la fila
 * viva: editarla a mitad de corrida no cambia este caso). Guion topado a 8.
 */
type RunPersona = {
  key: string;
  name: string;
  objetivo: string;
  rasgos: string | null;
  criteriosExito: string | null;
  guion: string[];
  contactName: string;
  phone: string;
  seed?: PersonaSeed;
  expectFicha?: Record<string, RegExp>;
};

function runPersonaOf(snap: LabPersonaSnapshot): RunPersona {
  return {
    key: snap.key,
    name: snap.name,
    objetivo: snap.objetivo,
    rasgos: snap.rasgos,
    criteriosExito: snap.criteriosExito,
    guion: snap.guion.slice(0, LAB_MAX_SCRIPT_MESSAGES),
    contactName: snap.contactName,
    phone: snap.phone,
    seed: snap.seed ?? undefined,
    expectFicha: compileExpectFicha(snap.expectFicha),
  };
}

async function runAllCases(
  runId: string,
  organizationId: string,
  plan: RunPlan,
  signal: AbortSignal
): Promise<void> {
  const db = getDb();
  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId))
    .orderBy(asc(schema.agentTestCase.createdAt));

  // 08 — Juez y diff ven lo MISMO: el KB y el comportamiento del snapshot.
  // Con el KB en modo `hashed` (> 1 MB) no hay texto en el snapshot: el juez
  // lee el KB vivo.
  const kbText =
    plan.config.kb.mode === "full"
      ? renderKb(
          plan.config.kb.entries.map((e) => ({
            kind: e.kind,
            question: "question" in e ? e.question : null,
            answer: "answer" in e ? e.answer : null,
            content: "content" in e ? e.content : null,
          }))
        )
      : renderKb(
          await db
            .select()
            .from(schema.kbEntry)
            .where(scoped(schema.kbEntry.organizationId, organizationId))
        );
  const behaviorText = behaviorTextOf(plan.config.profile);

  // La definición de la ficha no entra al snapshot: se lee viva (chequeo
  // informativo, fuera del score).
  const profileRows = await db
    .select({ fichaFields: schema.agentProfile.fichaFields })
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const fichaFields = profileRows[0]?.fichaFields ?? null;

  let done = 0;
  const total = cases.length;
  signal.throwIfAborted();
  publishProgress(organizationId, runId, "running", done, total);

  for (const testCase of cases) {
    if (!testCase.personaSnapshot) continue;
    const persona = runPersonaOf(testCase.personaSnapshot);

    signal.throwIfAborted();
    await db
      .update(schema.agentTestCase)
      .set({ status: "running" })
      .where(eq(schema.agentTestCase.id, testCase.id));

    const { transcript, conversationId, contactId, handoff } = await runConversation(
      organizationId,
      testCase.id,
      persona,
      signal
    );

    // 04 — Chequeo determinista de la ficha (no lo decide el juez). Un fallo
    // aquí no tumba el caso: el chequeo es informativo.
    signal.throwIfAborted();
    const fichaCheck = await readFichaCheck(
      organizationId,
      contactId,
      persona,
      fichaFields
    );

    // Sin juez si ya se abortó: ahorra la llamada al LLM.
    signal.throwIfAborted();
    const outcome = await judgeCase({
      personaKey: persona.key,
      // 08 — El juez evalúa contra el objetivo y los criterios de la persona.
      persona: {
        name: persona.name,
        objetivo: persona.objetivo,
        rasgos: persona.rasgos,
        criteriosExito: persona.criteriosExito,
      },
      seedText: seedText(persona),
      transcript,
      kbText,
      behaviorText,
      // 030 — El pase a humano no deja texto: el juez lo ve aparte.
      handoff,
    });

    signal.throwIfAborted();
    await db
      .update(schema.agentTestCase)
      .set({
        conversationId,
        transcript,
        status: outcome.status,
        veredicto: outcome.status === "done" ? outcome.verdict.veredicto : null,
        hallazgos: outcome.status === "done" ? outcome.verdict.hallazgos : null,
        fichaCheck,
      })
      .where(eq(schema.agentTestCase.id, testCase.id));

    done += 1;
    signal.throwIfAborted();
    publishProgress(organizationId, runId, "running", done, total);
  }

  const finalCases = await db
    .select({
      status: schema.agentTestCase.status,
      veredicto: schema.agentTestCase.veredicto,
    })
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId));
  const score = computeScore(finalCases);

  // Sin esto una corrida abortada podría pasar de `failed` a `done`.
  signal.throwIfAborted();
  await getDb()
    .update(schema.agentTestRun)
    .set({ status: "done", score, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "done", done, total, score);
}

/** Conversa el guion completo contra el agente real; corta al primer handoff. */
async function runConversation(
  organizationId: string,
  caseId: string,
  persona: RunPersona,
  signal: AbortSignal
): Promise<{
  transcript: { role: "cliente" | "agente"; text: string }[];
  conversationId: string;
  contactId: string;
  /** 030 — Pase a asesor con el que terminó el guion; null = ninguno. */
  handoff: JudgeHandoff | null;
}> {
  const db = getDb();

  // Contacto sintético ARCHIVADO (no aparece en la lista ni genera leads).
  signal.throwIfAborted();
  const contactId = await upsertTestContact(organizationId, persona);
  // 03 — Cada caso arranca del estado semilla de la persona: una corrida no
  // hereda las notas ni la ficha que el agente escribió en la anterior.
  signal.throwIfAborted();
  await resetTestContact({ organizationId, contactId, seed: persona.seed });

  const convId = newId("conversation");
  signal.throwIfAborted();
  await db.insert(schema.conversation).values({
    id: convId,
    organizationId,
    contactId,
    isTest: true,
    aiEnabled: true,
  });
  // Ligada al caso desde ya: si la corrida se interrumpe, borrarla
  // (lab/delete.ts) encuentra esta conversación y no queda huérfana.
  signal.throwIfAborted();
  await db
    .update(schema.agentTestCase)
    .set({ conversationId: convId })
    .where(eq(schema.agentTestCase.id, caseId));

  let handoff: JudgeHandoff | null = null;
  for (const line of persona.guion) {
    signal.throwIfAborted();
    const now = new Date();
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: convId,
      direction: "in",
      type: "text",
      text: line,
      status: "delivered",
      waTimestamp: now,
    });
    signal.throwIfAborted();
    await db
      .update(schema.conversation)
      .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversation.id, convId));

    // Turno REAL del agente, secuencial y sin debounce (FR-030). No acepta
    // señal: se chequea antes y después.
    signal.throwIfAborted();
    await runAgentTurn(convId);
    signal.throwIfAborted();

    const convRows = await db
      .select({
        handoffAt: schema.conversation.handoffAt,
        handoffReason: schema.conversation.handoffReason,
        handoffNote: schema.conversation.handoffNote,
      })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, convId))
      .limit(1);
    const conv = convRows[0];
    // 030 — Esta lectura tras el ÚLTIMO turno es el estado final del caso:
    // con handoff se corta el guion aquí mismo.
    if (conv?.handoffAt) {
      handoff = {
        reason: conv.handoffReason ?? null,
        note: conv.handoffNote ?? null,
      };
      break; // primer handoff → fin del guion
    }
  }

  const messages = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, convId))
    .orderBy(asc(schema.message.createdAt));

  return {
    conversationId: convId,
    contactId,
    handoff,
    transcript: messages
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("cliente" as const) : ("agente" as const),
        text: m.text!,
      })),
  };
}

/**
 * 04 — Lee la ficha con la que quedó el contacto sintético y la compara con
 * lo que la persona debía dejar (`expectFicha`). `null` si no aplica o si la
 * lectura falla (se registra sin valores).
 */
async function readFichaCheck(
  organizationId: string,
  contactId: string,
  persona: RunPersona,
  fields: readonly FichaFieldDef[] | null
): Promise<FichaCheck | null> {
  if (!persona.expectFicha || !fields?.length) return null;
  try {
    const rows = await getDb()
      .select({ ficha: schema.contact.ficha })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.id, contactId)
        )
      )
      .limit(1);
    return computeFichaCheck({
      expect: persona.expectFicha,
      fields,
      ficha: rows[0]?.ficha ?? null,
    });
  } catch (err) {
    console.error(
      `[lab] chequeo de ficha no disponible: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  }
}

/** 03 — La semilla en texto para el juez ("el agente tenía estos datos"). */
function seedText(persona: RunPersona): string | undefined {
  const s = persona.seed;
  if (!s) return undefined;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(s.ficha ?? {})) lines.push(`- ${k}: ${v}`);
  if (s.notes) lines.push(`- notas: ${s.notes}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function upsertTestContact(
  organizationId: string,
  persona: RunPersona
): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      phone: persona.phone,
      waIdentity: persona.phone,
      name: persona.contactName,
      archivedAt: new Date(),
    })
    // Ídem que en el alta manual: desde 014 el índice único incluye `channel`,
    // y un ON CONFLICT que no lo nombra no corresponde a ningún índice. Sin
    // esto, TODA corrida del Laboratorio muere antes de la primera persona.
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0].id;
  const rows = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.phone, persona.phone)
      )
    )
    .limit(1);
  return rows[0]!.id;
}

/** `total` = nº de casos de la corrida (08: ya no `PERSONAS.length`). */
async function failRun(
  runId: string,
  organizationId: string,
  error: string,
  total: number
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "failed", 0, total);
}

function publishProgress(
  organizationId: string,
  runId: string,
  status: string,
  done: number,
  total: number,
  score?: number | null
): void {
  publish(organizationId, {
    type: "lab.run",
    data: { runId, status, progress: { done, total }, score },
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}
