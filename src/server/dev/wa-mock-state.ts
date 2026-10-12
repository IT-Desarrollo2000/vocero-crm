/**
 * Estado en memoria del harness wa-mock (solo dev/test). Vive en globalThis
 * porque Next recarga módulos en dev; una instancia = un proceso, así que el
 * outbox en memoria es suficiente para las aserciones del self-test.
 */

export type OutboxEntry = {
  n: number;
  phoneNumberId: string;
  to: string;
  type: string;
  body: unknown;
  at: string;
  /**
   * Id que se le devolvió al CRM. Lo expone el outbox para que un self-test
   * pueda mandarle un webhook de estado a ESE mensaje sin adivinar el formato.
   */
  waMessageId?: string;
};

export type MockTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  body: string;
  /** Componentes tal cual los mandó el CRM: Meta valida aquí los `example`. */
  components?: unknown[];
};

/**
 * 016 — Un evento de Conversions API que el CRM le mandó al mock. El self-test
 * lo inspecciona para verificar la FORMA del payload: el modo de fallar de ese
 * endpoint es un 200 con `events_received: 0`, donde un campo mal puesto se ve
 * idéntico a uno bien puesto.
 */
export type CapiMockEvent = {
  n: number;
  datasetId: string;
  eventName: string;
  ctwaClid: string | null;
  customData: Record<string, unknown> | null;
  body: unknown;
  at: string;
};

/**
 * 10 — Disparador de falla para los envíos de WhatsApp (`{phoneNumberId}/
 * messages` sin `recipient.id`; no afecta el "leído/escribiendo…" ni a
 * Instagram/Messenger, que tienen su `-down` por token). Conmutable por
 * `POST /api/dev/wa-mock/fail-sends`.
 *
 * - `error` → 400 de Meta (131026, mensaje no entregable): el CRM lo ve como
 *   `SendError("meta_error")` con el texto de Meta como motivo.
 * - `down`  → 503: `SendError("meta_unavailable")`.
 */
export type FailSendsMode = "off" | "error" | "down";

type WaMockState = {
  outbox: OutboxEntry[];
  templates: MockTemplate[];
  capiEvents: CapiMockEvent[];
  counter: number;
  /** Se apaga también con `DELETE /api/dev/wa-mock/outbox` (reset total). */
  failSends: FailSendsMode;
};

const globalForMock = globalThis as unknown as { __waMockState?: WaMockState };

function freshState(): WaMockState {
  return {
    outbox: [],
    templates: [],
    capiEvents: [],
    counter: 0,
    failSends: "off",
  };
}

export function getWaMockState(): WaMockState {
  if (!globalForMock.__waMockState) {
    globalForMock.__waMockState = freshState();
  }
  return globalForMock.__waMockState;
}

export function resetWaMockState(): void {
  globalForMock.__waMockState = freshState();
}

export function nextN(): number {
  return ++getWaMockState().counter;
}

/**
 * Sello único por arranque del proceso. Sin él, el contador del mock reinicia
 * al reiniciar `pnpm dev` y vuelve a emitir `wamid.mock.out.1`, que choca con
 * el UNIQUE de `wa_message_id` en la BD de una corrida anterior (500 al
 * enviar). No es un fallo del producto: la idempotencia hace su trabajo.
 */
const boot = Math.random().toString(36).slice(2, 8);

export function nextOutboundWamid(): string {
  return `wamid.mock.out.${boot}.${nextN()}`;
}

/**
 * Lo mismo vale para el entrante y el eco simulados: con `wamid.mock.in.1`
 * repetido, el ingest lo descarta como duplicado y la conversación queda vacía
 * (sin mensaje ni ventana de 24 h abierta).
 */
export function nextInboundWamid(): string {
  return `wamid.mock.in.${boot}.${nextN()}`;
}

export function nextEchoWamid(): string {
  return `wamid.mock.echo.${boot}.${nextN()}`;
}
