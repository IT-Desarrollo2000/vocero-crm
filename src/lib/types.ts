/** DTOs que viajan por la API interna (lado cliente). */

import type { Channel, ReplyMode } from "@/lib/channels";
import type {
  FichaFieldDef,
  FichaIgnored,
  FichaIgnoreReason,
  FichaMeta,
  FichaOutcome,
  FichaSource,
} from "@/lib/ficha-fields";

export type ConversationDto = {
  id: string;
  /** 014: canal de la conversacion, para el distintivo de la bandeja. */
  channel: Channel;
  contact: { id: string; name: string; phone: string | null };
  stageName: string | null;
  aiEnabled: boolean;
  handoffAt: string | null;
  handoffReason: string | null;
  /** Explicación libre de quien escaló (agente o cerebro externo), o null. */
  handoffNote: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  windowOpen: boolean;
  windowRemainingMs: number;
  /**
   * 017: cómo puede responder hoy el operador, según las reglas del canal.
   * El compositor decide con esto, no con `windowOpen` (que solo habla de
   * las 24 h y hacía que una conversación de Instagram pidiera plantillas).
   */
  replyMode: ReplyMode;
  /** 017: ¿el canal acepta adjuntos, ubicación y contactos salientes? */
  outboundMedia: boolean;
  /** 017: ¿existen plantillas en este canal? Solo WhatsApp. */
  templates: boolean;
  preview: string | null;
  /**
   * 09: responsable de la conversación, o null = sin asignar. `name` es el
   * nombre del usuario (puede seguir aquí tras su baja hasta que
   * `onMemberRemoved` la libere).
   */
  assignedTo: { userId: string; name: string } | null;
  /** 09: ISO de cuándo la tomó su responsable actual; null si sin asignar. */
  assignedAt: string | null;
  /**
   * 06: ISO (ms) de `coalesce(lastMessageAt, createdAt)`, la clave de orden
   * de la lista. Solo para que el cliente reordene tras un upsert; NUNCA se
   * usa para construir un cursor (el cursor sale del servidor, en µs).
   */
  sortAt: string;
  /** 06: etapa del lead del contacto (filtro `stage=<stageId>`), o null. */
  stageId: string | null;
};

/**
 * 09: filtro de responsable de `GET /api/conversations?assigned=`. Siempre
 * DENTRO de lo visible para quien pide: `all` = todo lo visible (default).
 */
export type AssignedFilter = "me" | "unassigned" | "all";

/**
 * 06: pastilla de la Bandeja, `GET /api/conversations?filter=`.
 * `human` = handoff o IA pausada (regla `needsHuman`); `mine`/`unassigned` =
 * mismo predicado que `assigned=me|unassigned` (si llegan ambos, se
 * intersectan). Valor desconocido → `all` (tolerante).
 */
export type InboxFilter = "all" | "unread" | "human" | "mine" | "unassigned";

/**
 * 06: respuesta de `GET /api/conversations`. `nextCursor` es opaco (lo arma
 * el servidor); `null` = no hay más, o petición sin `limit` (lista completa,
 * D-06-1), o modos `ids`/`contact`/`since`.
 */
export type ConversationsPage = {
  conversations: ConversationDto[];
  nextCursor: string | null;
};

/**
 * 06: respuesta de `GET /api/conversations/counts`, siempre dentro de lo
 * visible para quien pide. Capas (ver dev-tasks/06, "Contrato 06-0"):
 * - base = visibilidad ∧ q ∧ stage ∧ assigned;
 * - `all`/`unread`/`human`/`mine`/`unassigned` = base ∧ channel ∧ pastilla;
 * - `byChannel` = base (sin channel ni pastilla);
 * - `unreadConversations`/`unreadMessages`/`teamMode` = solo visibilidad.
 */
export type ConversationCounts = {
  all: number;
  unread: number;
  human: number;
  mine: number;
  unassigned: number;
  byChannel: Record<Channel, number>;
  /** Conversaciones con `unread_count > 0`: badge del menú/pestaña (D-05-1). */
  unreadConversations: number;
  /** Suma de `unread_count` (informativo; el badge NO lo usa). */
  unreadMessages: number;
  /**
   * ¿Mostrar la asignación? `!owner || miembros(org) > 1 || existe alguna
   * conversación visible con responsable`. Estable: no depende de lo cargado.
   */
  teamMode: boolean;
};

/**
 * 09: body de `POST /api/conversations/[id]/assign`.
 * `userId` = user id (NO el id de membresía) o null = sin asignar.
 * `expect: "unassigned"` = solo si nadie la tiene (semántica de "tomar");
 * para el Vendedor que se asigna a sí mismo es implícito.
 */
export type AssignBody = { userId: string | null; expect?: "unassigned" };

/** 09: body de `POST /api/quick-replies`. `position` default = al final. */
export type QuickReplyCreateBody = {
  shortcut: string;
  title: string;
  body: string;
  position?: number;
};

/** 09: body de `PATCH /api/quick-replies/[id]` (al menos un campo). */
export type QuickReplyPatchBody = Partial<QuickReplyCreateBody>;

/** 09: respuesta rápida del catálogo de la organización. */
export type QuickReplyDto = {
  id: string;
  /** Sin la barra, en minúsculas: `^[a-z0-9_-]{1,32}$`. */
  shortcut: string;
  title: string;
  /** Texto con variables sin sustituir (`{{nombre}}`…); lo rinde el cliente. */
  body: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

/** 008 — Adjunto de un mensaje, para previsualización en el hilo. */
export type MessageMediaDto = {
  assetId: string;
  kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "contacts";
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  caption: string | null;
  fetchStatus: "available" | "pending" | "failed";
  /** location {latitude, longitude, name?, address?} / contacts (subset). */
  payload: unknown;
};

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  type: string;
  text: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** Motivo del fallo en lenguaje llano cuando status = "failed". */
  error: string | null;
  aiGenerated: boolean;
  /** 008 — Origen del saliente (en entrantes viene 'operator' y se ignora). */
  origin: "ai" | "operator" | "manual" | "template";
  media: MessageMediaDto | null;
  createdAt: string;
};

export type TemplateDto = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: "draft" | "pending" | "approved" | "rejected";
  rejectionReason: string | null;
};

export type StageDto = {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
};

/** Un dato de la ficha. Escalar a propósito: ver `server/bot/ficha`. */
export type FichaValue = string | number | boolean;

/**
 * Ficha de calificación del lead. Claves libres: cada negocio califica
 * distinto, así que las define quien pregunta —el agente o el dueño— y el CRM
 * no las cablea.
 */
export type FichaDto = Record<string, FichaValue>;

export type ContactDto = {
  id: string;
  name: string;
  /** null en contactos que llegaron solo con BSUID (003). */
  phone: string | null;
  notes: string | null;
  /** Etapa del embudo del lead asociado; null si el contacto no tiene lead. */
  stageName: string | null;
  archivedAt: string | null;
  /** De dónde salió el prospecto, capturada o deducida. */
  source?: SourceDto;
  /** Prioridad del lead asociado; null si nadie la fijó. */
  priority?: PriorityValue | null;
  /** Lo que se sabe del lead. `{}` mientras nadie haya calificado. */
  ficha?: FichaDto;
  /**
   * 04 — Procedencia por clave de `ficha`. `{}` si nadie ha escrito desde 04.
   * Clave con valor y SIN entrada = dato anterior a 04 (legado): el agente no
   * lo pisa. Candado = `fichaMeta[key].by === "humano"`.
   */
  fichaMeta?: FichaMeta;
};

/* ============================================================
 * 04 — Campos de la ficha (contrato 04-0,
 * dev-tasks/04-el-agente-llena-la-ficha.md)
 * ============================================================ */

/**
 * `GET /api/agent/ficha-fields` y respuesta de `PUT`. `null` = sin
 * definición (ficha libre; el agente no llena nada).
 */
export type FichaFieldsResponse = { fields: FichaFieldDef[] | null };

/** Cuerpo de `PUT /api/agent/ficha-fields`. `[]` equivale a `null`. */
export type FichaFieldsPutBody = { fields: FichaFieldDef[] | null };

/** `GET /api/contacts/[id]`: lo de siempre + la definición para pintar el panel. */
export type ContactDetailResponse = {
  contact: ContactDto & { ficha: FichaDto; fichaMeta: FichaMeta };
  stage: StageDto | null;
  lead: { id: string } | null;
  fichaFields: FichaFieldDef[] | null;
};

/** Cuerpo de `PATCH /api/contacts/[id]` (lo de ficha; el resto, igual que hoy). */
export type ContactPatchBody = {
  name?: string;
  notes?: string | null;
  archived?: boolean;
  /** Parche (no reemplazo). `null` borra la clave. Queda con candado humano. */
  ficha?: Record<string, FichaValue | null>;
  /**
   * Quita el candado sin borrar el valor: `by` pasa a `"ia"` (RF-04-08).
   * Aplica a claves `humano` y legadas (con valor, sin meta); máx. 40.
   */
  fichaUnlock?: string[];
};

/** Una fila de la bitácora `ficha_event`. */
export type FichaEventDto = {
  id: string;
  key: string;
  /** null = la clave no tenía valor. */
  oldValue: FichaValue | null;
  /** null = borrado (aplicado) o intento sin valor guardable (invalido). */
  newValue: FichaValue | null;
  source: FichaSource;
  outcome: FichaOutcome;
  reason: FichaIgnoreReason | null;
  /** Solo `source = "humano"`; null si el usuario ya no existe. */
  actor: { id: string; name: string } | null;
  conversationId: string | null;
  createdAt: string;
};

/** `GET /api/contacts/[id]/ficha/history`: últimos 50, más reciente primero. */
export type FichaHistoryResponse = { events: FichaEventDto[] };

/** `PUT /api/bot/ficha` (aditivo: `ignored`). */
export type BotFichaResponse = {
  ficha: FichaDto;
  ignored: FichaIgnored[];
};

/* ============================================================
 * Bitácora de etapas
 * ============================================================ */

/** Por qué se perdió un trato. Lista corta a propósito: una taxonomía larga
 *  se responde "otro" y deja de informar. */
export type LossReason =
  | "precio"
  | "no_es_perfil"
  | "sin_presupuesto"
  | "eligio_otro"
  | "nunca_contesto"
  | "otro";

export const LOSS_REASON_LABEL: Record<LossReason, string> = {
  precio: "Le pareció caro",
  no_es_perfil: "No era el perfil",
  sin_presupuesto: "Sin presupuesto ahora",
  eligio_otro: "Se fue con otro",
  nunca_contesto: "Nunca contestó",
  otro: "Otro",
};

/** Quién provocó un movimiento de etapa. */
export type StageChangeSource = "dueno" | "bot" | "sistema" | "migracion";

/* ============================================================
 * Fuente del prospecto
 * ============================================================ */

export type SourceValue =
  | "anuncio"
  | "organico"
  | "referido"
  | "conocido"
  | "otro";

export type SourceDto = {
  /** "desconocida" cuando nadie la capturó y no se pudo deducir. */
  value: SourceValue | "desconocida";
  /** `deducida` = la infirió el sistema; `capturada` = la puso el dueño. */
  source: "capturada" | "deducida";
};

/* ============================================================
 * Prioridad del lead
 * ============================================================ */

/** La fija el dueño; NULL = nadie la ha decidido (no es "media"). */
export type PriorityValue = "alta" | "media" | "baja";

/* ============================================================
 * 10 — Recordatorios de cita (fuente canónica: src/lib/reminders.ts)
 * ============================================================ */

export type {
  BookingReminderDto,
  BookingReminderSkipReason,
  BookingReminderStatus,
  ReminderDeliveryStatus,
  ReminderField,
  ReminderRetryResultDto,
  ReminderSettingsDto,
  ReminderSettingsInput,
  ReminderTemplateSummaryDto,
  ReminderTickResultDto,
} from "@/lib/reminders";
