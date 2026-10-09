import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { runAgentTurn } from "@/server/ai/pipeline";
import { renderKb } from "@/server/ai/prompts";
import { computeScore, judgeCase } from "@/server/lab/judge";
import { PERSONAS, type Persona } from "@/server/lab/personas";

/**
 * Runner del Laboratorio (FR-030/FR-034): corrida en segundo plano DENTRO del
 * proceso (sin cola externa), turnos secuenciales con debounce 0, timeout
 * global (10 min por defecto, `LAB_RUN_TIMEOUT_MS`), y lock de concurrencia
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

export class RunConflictError extends Error {}

export async function startRun(organizationId: string): Promise<string> {
  const db = getDb();
  let runId: string;
  try {
    const inserted = await db
      .insert(schema.agentTestRun)
      .values({ id: newId("testRun"), organizationId, status: "running" })
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
    PERSONAS.map((p) => ({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: p.key,
      status: "pending" as const,
    }))
  );

  // Fire-and-forget in-process: el POST regresa ya; el progreso va por SSE.
  void executeRun(runId, organizationId).catch(async (err) => {
    console.error("[lab] corrida falló:", err);
    await failRun(runId, organizationId, String(err));
  });

  return runId;
}

async function executeRun(
  runId: string,
  organizationId: string
): Promise<void> {
  const timeoutMs = parseRunTimeoutMs(process.env.LAB_RUN_TIMEOUT_MS);
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

  const work = runAllCases(runId, organizationId, signal);
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
    await failRun(runId, organizationId, String(signal.reason));
  } catch (err) {
    // Fallo propio de la corrida (no timeout): se aborta igual por si algo
    // quedara en vuelo.
    controller.abort(err);
    await closeRunningCases(runId);
    await failRun(runId, organizationId, String(err));
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

async function runAllCases(
  runId: string,
  organizationId: string,
  signal: AbortSignal
): Promise<void> {
  const db = getDb();
  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId))
    .orderBy(asc(schema.agentTestCase.createdAt));

  const kbEntries = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId));
  const kbText = renderKb(kbEntries);

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  const behaviorText = profile
    ? [
        `Nombre: ${profile.name}`,
        profile.tone ? `Tono: ${profile.tone}` : null,
        profile.instructions ? `Instrucciones: ${profile.instructions}` : null,
        profile.escalationRules ? `Escalado: ${profile.escalationRules}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  let done = 0;
  const total = cases.length;
  signal.throwIfAborted();
  publishProgress(organizationId, runId, "running", done, total);

  for (const testCase of cases) {
    const persona = PERSONAS.find((p) => p.key === testCase.persona);
    if (!persona) continue;

    signal.throwIfAborted();
    await db
      .update(schema.agentTestCase)
      .set({ status: "running" })
      .where(eq(schema.agentTestCase.id, testCase.id));

    const { transcript, conversationId } = await runConversation(
      organizationId,
      testCase.id,
      persona,
      signal
    );

    // Sin juez si ya se abortó: ahorra la llamada al LLM.
    signal.throwIfAborted();
    const outcome = await judgeCase({
      personaKey: persona.key,
      transcript,
      kbText,
      behaviorText,
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
  persona: Persona,
  signal: AbortSignal
): Promise<{
  transcript: { role: "cliente" | "agente"; text: string }[];
  conversationId: string;
}> {
  const db = getDb();

  // Contacto sintético ARCHIVADO (no aparece en la lista ni genera leads).
  signal.throwIfAborted();
  const contactId = await upsertTestContact(organizationId, persona);

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

  for (const line of persona.script) {
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
      .select({ handoffAt: schema.conversation.handoffAt })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, convId))
      .limit(1);
    if (convRows[0]?.handoffAt) break; // primer handoff → fin del guion
  }

  const messages = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, convId))
    .orderBy(asc(schema.message.createdAt));

  return {
    conversationId: convId,
    transcript: messages
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("cliente" as const) : ("agente" as const),
        text: m.text!,
      })),
  };
}

async function upsertTestContact(
  organizationId: string,
  persona: Persona
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

async function failRun(
  runId: string,
  organizationId: string,
  error: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "failed", 0, PERSONAS.length);
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
