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
  /**
   * 018 — Adjunto de Messenger/Instagram (`type: "attachment"`). Messenger
   * sube los bytes en el mismo /messages (multipart `filedata`); Instagram
   * (y el catálogo de Messenger) los sube antes a `message_attachments` y
   * envía por `attachment_id`. `fileName`/`mime`/`bytes` son los recibidos
   * en la subida.
   */
  attachment?: {
    channel: "messenger" | "instagram";
    attachmentType: string;
    fileName?: string | null;
    mime?: string | null;
    bytes?: number;
    /** 019 fase B / arreglo IG — enviado por `attachment_id` (ya subido). */
    attachmentId?: string;
    /** Forma en que llegó: `message.attachments` (arreglo) o `message.attachment`. */
    shape?: "attachments" | "attachment";
  };
};

/**
 * 019 fase B — Una subida de bytes a Meta: `POST {phoneNumberId}/media`
 * (WhatsApp) o `POST {id}/message_attachments` (Messenger con el page id;
 * Instagram con el id de la cuenta y `platform=instagram`). Va APARTE
 * del outbox (campo `uploads` de `GET /api/dev/wa-mock/outbox`) para no
 * alterar los guiones que cuentan mensajes; el self-test cuenta aquí cuántas
 * veces se subió un archivo (reutilización del catálogo).
 */
export type UploadEntry = {
  n: number;
  kind: "upload";
  channel: "whatsapp" | "messenger" | "instagram";
  /** phone_number_id, page id o id de la cuenta de Instagram. */
  accountId: string;
  /** media id (WhatsApp) o attachment_id (Messenger/Instagram) devuelto. */
  id: string;
  fileName: string | null;
  mime: string | null;
  bytes: number;
  /** message_attachments: `attachment.type` y `is_reusable` recibidos. */
  attachmentType?: string;
  isReusable?: boolean;
  at: string;
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
  /**
   * NO se reinicia con el reset: los ids que emite (wamids, media ids) ya
   * pueden estar en la BD, y repetirlos choca con el UNIQUE de
   * `message.wa_message_id` en el mismo arranque.
   */
  counter: number;
  /** Se apaga también con `DELETE /api/dev/wa-mock/outbox` (reset total). */
  failSends: FailSendsMode;
  /** 019 fase B — Subidas de bytes (ver `UploadEntry`). */
  uploads: UploadEntry[];
  /**
   * 019 fase B — Ids subidos (media id / attachment_id) que Meta "ya no
   * reconoce": `/messages` con ellos responde 400. Se llena con
   * `POST /api/dev/wa-mock/invalidate-media`.
   */
  invalidMediaIds: Set<string>;
  /** Todos los ids subidos en este proceso (para `invalidate-media {all}`). */
  issuedUploadIds: string[];
  /**
   * 020 fase C — Cada `POST {id}/subscribed_apps` recibido (WABA o Página),
   * con los campos pedidos y si se aceptó. Aparte del outbox, como `uploads`.
   */
  subscriptions: SubscriptionEntry[];
  /**
   * Nombres de Messenger: con `down` el `GET {pageId}/conversations` falla
   * (además del perfil "sinperfil"), para dejar un contacto con el respaldo y
   * luego probar que se renombra. `POST /api/dev/wa-mock/fb-conversations`;
   * el reset total lo regresa a `ok`.
   */
  fbConversations: "ok" | "down";
};

/** 020 fase C — Una suscripción `subscribed_apps` que el CRM pidió. */
export type SubscriptionEntry = {
  accountId: string;
  fields: string[] | null;
  accepted: boolean;
  at: string;
};

const globalForMock = globalThis as unknown as { __waMockState?: WaMockState };

function freshState(prev?: WaMockState): WaMockState {
  return {
    outbox: [],
    templates: [],
    capiEvents: [],
    counter: prev?.counter ?? 0,
    failSends: "off",
    uploads: [],
    invalidMediaIds: new Set(),
    issuedUploadIds: prev?.issuedUploadIds ?? [],
    subscriptions: [],
    fbConversations: "ok",
  };
}

export function getWaMockState(): WaMockState {
  if (!globalForMock.__waMockState) {
    globalForMock.__waMockState = freshState();
  }
  const state = globalForMock.__waMockState;
  // Un estado creado por una versión anterior del módulo (recarga en dev)
  // puede no traer los campos de 019.
  state.uploads ??= [];
  state.invalidMediaIds ??= new Set();
  state.issuedUploadIds ??= [];
  state.subscriptions ??= [];
  state.fbConversations ??= "ok";
  return state;
}

/** Reset total salvo el contador de ids (ver `counter`). */
export function resetWaMockState(): void {
  globalForMock.__waMockState = freshState(globalForMock.__waMockState);
}

/** 019 fase B — Registra una subida y devuelve el id que se le da al CRM. */
export function recordUpload(
  entry: Omit<UploadEntry, "n" | "kind" | "id" | "at">,
  idPrefix: "media-up" | "att-up"
): string {
  const state = getWaMockState();
  const n = nextN();
  // Sello de arranque solo con dígitos: `mockDeclaredMime`/`mockMediaBytes`
  // deciden por subcadenas del id ("pdf", "exe", "html").
  const id = `${idPrefix}-${bootDigits}-${n}`;
  state.uploads.push({ n, kind: "upload", id, at: new Date().toISOString(), ...entry });
  state.issuedUploadIds.push(id);
  return id;
}

export function isInvalidMediaId(id: unknown): boolean {
  return typeof id === "string" && getWaMockState().invalidMediaIds.has(id);
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
const bootDigits = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");

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
