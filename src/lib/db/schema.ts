import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { FichaCheck, FichaFieldDef, FichaMeta } from "../ficha-fields";
import {
  BOOKING_REMINDER_SKIP_REASONS,
  BOOKING_REMINDER_STATUSES,
} from "../reminders";
import type { ProductAttribute } from "../catalog";
import type {
  LabConfigSnapshot,
  LabExpectFichaRule,
  LabPersonaSeedData,
  LabPersonaSnapshot,
} from "../lab";

/* ============================================================
 * Auth (Better Auth + plugin organization)
 * ============================================================ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // 0013 (tarea 00): una membresía por persona y organización. El alta de
    // equipo hace ON CONFLICT contra este índice.
    uniqueIndex("member_org_user_uq").on(t.organizationId, t.userId),
  ]
);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ============================================================
 * Dominio (toda tabla lleva organization_id NOT NULL + índice org-first)
 * ============================================================ */

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Llave de resolución WhatsApp (003): teléfono normalizado (521→52) o
     * `bsuid:<id>` cuando Meta no manda wa_id. Estable de por vida.
     */
    /**
     * 014: canal por el que vive este contacto. Aditivo y con default: toda
     * fila existente sigue significando exactamente lo mismo.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * Llave de resolucion. WhatsApp: telefono normalizado (521 a 52) o
     * `bsuid:<id>`. Instagram (014): `ig:<IGSID>`. Messenger (017):
     * `fb:<PSID>`. Estable de por vida.
     * El nombre `wa_identity` se conserva porque es contrato publicado:
     * `/api/bot/context?waIdentity=...` lo recibe y lo devuelve, y hay
     * cerebros externos que dependen de el.
     */
    waIdentity: text("wa_identity").notNull(),
    /** Teléfono como ATRIBUTO opcional (003): falta en contactos BSUID. */
    phone: text("phone"),
    /** Business-Scoped User ID si se conoce (003). */
    waUserId: text("wa_user_id"),
    name: text("name").notNull(),
    /**
     * 022: nombre de perfil del canal ("Dios es amor"), aparte del `name` que
     * pone el equipo. WhatsApp lo manda en cada entrante y se actualiza; en
     * Instagram/Messenger se captura cuando ya se consulta a Graph (o Zernio
     * lo trae). NULL = desconocido. Renombrar nunca lo toca.
     */
    profileName: text("profile_name"),
    notes: text("notes"),
    /**
     * Ficha de calificación que levanta un cerebro externo por
     * `PUT /api/bot/ficha`. Es un objeto libre a propósito: los datos que
     * importan de un lead los define cada negocio (una clínica querrá
     * "tratamiento", una constructora "metros"), y cablearlos como columnas
     * obligaría a migrar el CRM cada vez que alguien cambia su cuestionario.
     * Merge campo a campo; `null` explícito borra la clave.
     */
    ficha: jsonb("ficha").$type<Record<string, unknown>>(),
    /**
     * 04 — Procedencia por clave de `ficha` (`{ [key]: { by, at, userId? } }`).
     * Sidecar a propósito: la forma de `ficha` es contrato publicado. NULL o
     * clave ausente = sin procedencia (dato anterior a 04: el agente no lo
     * pisa). Solo la escribe la puerta `src/server/bot/ficha.ts`.
     */
    fichaMeta: jsonb("ficha_meta").$type<FichaMeta>(),
    /**
     * De dónde salió el prospecto. NULL = nadie la capturó, y entonces la API
     * la deduce. Así no hace falta backfill ni marcar en falso los contactos
     * que ya existían.
     */
    source: text("source", {
      enum: ["anuncio", "organico", "referido", "conocido", "otro"],
    }),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 014: el canal entra en la llave. Sin el, un IGSID que coincidiera con
    // un telefono normalizado mezclaria dos personas en silencio.
    uniqueIndex("contact_org_channel_identity_uq").on(
      t.organizationId,
      t.channel,
      t.waIdentity
    ),
    index("contact_org_wa_user_id_idx").on(t.organizationId, t.waUserId),
    index("contact_org_name_idx").on(t.organizationId, t.name),
  ]
);

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** open = etapa normal · won / lost = anclas no borrables */
    kind: text("kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** 022: "No archivar" — sus leads quedan fuera del archivo masivo/auto. */
    keepActive: boolean("keep_active").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("stage_org_pos_idx").on(t.organizationId, t.position)]
);

export const lead = pgTable(
  "lead",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    position: integer("position").notNull().default(0),
    /**
     * Monto de la negociación en CENTAVOS ENTEROS. NULL = nadie lo capturó, que
     * no es lo mismo que cero: un trato sin monto no vale $0, simplemente no se
     * sabe, y el tablero lo dice con palabras en vez de sumar un cero.
     */
    amountCents: integer("amount_cents"),
    /** Moneda del monto; la del negocio al capturarlo (Ajustes → Marca). */
    currency: text("currency"),
    /**
     * Prioridad de cierre. NULL = nadie la ha decidido, que NO es lo mismo que
     * "media": nada la escribe automáticamente, así que el dueño puede confiar
     * en que lo que ve es lo que él puso.
     */
    priority: text("priority", { enum: ["alta", "media", "baja"] }),
    priorityUpdatedAt: timestamp("priority_updated_at"),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_contact_uq").on(t.contactId),
    index("lead_org_stage_idx").on(t.organizationId, t.stageId, t.position),
  ]
);

/**
 * Bitácora de movimientos de etapa: append-only. Nada se actualiza ni se borra;
 * corregir un dato es agregar un movimiento nuevo.
 *
 * Es el cimiento de todo lo histórico: sin ella el CRM solo sabe dónde está
 * cada lead HOY, y "¿cuánto cerré en julio?" no tiene respuesta.
 *
 * Regla dura: la ÚNICA puerta que escribe aquí —y que escribe `lead.stage_id`—
 * es `src/server/leads/stage-history.ts`. Un unit test de vigilancia falla si
 * aparece otra escritura, porque un camino que mueva el lead sin registrar el
 * evento no truena: solo hace que las gráficas mientan meses después.
 */
export const leadStageEvent = pgTable(
  "lead_stage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Denormalizado a propósito: casi toda agregación cruza con el contacto,
     *  y el join extra se pagaría en cada consulta. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** NULL = el lead nació en `toStage` (evento de creación). */
    fromStageId: text("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    fromStageName: text("from_stage_name"),
    toStageId: text("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    /** Snapshots: sobreviven al renombre y al borrado de la etapa, para que
     *  reorganizar el tablero de hoy no reescriba el embudo del pasado. */
    toStageName: text("to_stage_name").notNull(),
    toStageKind: text("to_stage_kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** Cuándo PASÓ (no cuándo se registró). */
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    /** NULL = no lo movió una persona (bot, sistema, migración). */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source", {
      enum: ["dueno", "bot", "sistema", "migracion"],
    })
      .notNull()
      .default("dueno"),
    /** true = fecha SEMBRADA en la migración, no observada. Cuenta para los
     *  totales pero jamás para promedios de tiempo. */
    approximate: boolean("approximate").notNull().default(false),
    lossReason: text("loss_reason", {
      enum: [
        "precio",
        "no_es_perfil",
        "sin_presupuesto",
        "eligio_otro",
        "nunca_contesto",
        "otro",
      ],
    }),
    lossNote: text("loss_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("lse_org_occurred_idx").on(t.organizationId, t.occurredAt),
    index("lse_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lse_org_kind_occurred_idx").on(
      t.organizationId,
      t.toStageKind,
      t.occurredAt
    ),
    // Perder un trato sin motivo es imposible a nivel de BASE, no por
    // disciplina de cada ruta. La excepción es la siembra de la migración: no
    // puede inventar un motivo que nadie capturó.
    check(
      "lse_loss_reason_ck",
      sql`${t.toStageKind} <> 'lost' OR ${t.approximate} = true OR ${t.lossReason} IS NOT NULL`
    ),
  ]
);

/**
 * Catálogo de motivos de handoff: una sola fuente para la columna de
 * `conversation` y la bitácora `conversation_handoff_event`.
 */
export const HANDOFF_REASONS = [
  "cliente",
  "modelo",
  "error",
  "ventana",
  "hostilidad",
  "manual_reply",
] as const;

/** Quién provocó un escalamiento (`conversation_handoff_event.source`). */
export const HANDOFF_SOURCES = [
  "agente",
  "bot_externo",
  "telefono",
  "operador",
  "sistema",
  "migracion",
] as const;

/** 022: por qué se archivó una conversación (para deshacer en lote después). */
export const ARCHIVED_REASONS = ["manual", "bulk", "auto"] as const;

export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Conversación del Laboratorio: jamás toca la API de WhatsApp. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * 014: canal de la conversacion. Denormalizado del contacto a proposito:
     * el ruteo de salida y el filtro de la bandeja lo leen en cada mensaje.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * 014: identificador del hilo en la plataforma de origen. Zernio entrega
     * un conversationId opaco ("no asumas su formato") que hace falta para
     * responder; WhatsApp no lo necesita y queda null.
     */
    channelThreadRef: text("channel_thread_ref"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffAt: timestamp("handoff_at"),
    handoffReason: text("handoff_reason", {
      // 008: manual_reply = el dueño respondió desde la app del teléfono.
      // hostilidad = el lead se puso agresivo y el agente se retiró.
      enum: HANDOFF_REASONS,
    }),
    /**
     * Explicación libre de quien escaló (el agente o el cerebro externo): el
     * `handoffReason` es un catálogo cerrado y no cuenta el porqué concreto.
     * Se limpia junto con handoffAt/handoffReason.
     */
    handoffNote: text("handoff_note"),
    lastInboundAt: timestamp("last_inbound_at"),
    lastMessageAt: timestamp("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    /**
     * 09: responsable de la conversación (a lo sumo uno). NULL = sin asignar.
     * Solo usuarios miembros de la org; las `is_test` nunca se asignan. La
     * baja de un vendedor la devuelve a NULL (`onMemberRemoved`); el
     * ON DELETE SET NULL cubre además un borrado físico del usuario.
     */
    assignedUserId: text("assigned_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** 09: cuándo la tomó su responsable actual (NULL si sin asignar). */
    assignedAt: timestamp("assigned_at"),
    /**
     * 022: archivada = fuera de las vistas normales de la Bandeja. Archivar
     * nunca borra; un entrante o un saliente exitoso la desarchiva.
     */
    archivedAt: timestamp("archived_at"),
    archivedReason: text("archived_reason", { enum: ARCHIVED_REASONS }),
    /** 022: quién la archivó (NULL en auto o si el usuario ya no existe). */
    archivedBy: text("archived_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Una conversación real por contacto; las de prueba no compiten.
    uniqueIndex("conversation_org_contact_real_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.isTest} = false`),
    index("conversation_org_last_idx").on(t.organizationId, t.lastMessageAt),
    // 09: Bandeja por responsable ("Mías" / "Sin asignar").
    index("conversation_org_assignee_idx").on(
      t.organizationId,
      t.assignedUserId
    ),
    // 06: orden de la Bandeja (keyset sobre (sort_at, id), migración 0016).
    // NO parcial: `is_test = false` viaja como parámetro y un plan genérico
    // no podría probar el predicado de un índice parcial. Las expresiones van
    // como SQL crudo para que el texto (`DESC`, sin `NULLS LAST`) sea idéntico
    // al ORDER BY de `listConversations` (dev-tasks/06, "Contrato 06-0").
    index("conversation_org_sort_idx").on(
      t.organizationId,
      sql`(coalesce(${t.lastMessageAt}, ${t.createdAt})) DESC`,
      sql`${t.id} DESC`
    ),
    // 022: vista "Archivadas". Parcial: la inmensa mayoría no está archivada.
    index("conversation_org_archived_idx")
      .on(t.organizationId, t.archivedAt)
      .where(sql`${t.archivedAt} IS NOT NULL`),
  ]
);

/**
 * 04 — Bitácora de la ficha: append-only. Una fila por clave cuyo valor cambió
 * o cuyo intento de escritura se ignoró (candado humano, tipo, opción, tope…).
 * Reenviar el mismo valor no genera fila.
 *
 * Regla dura: la ÚNICA puerta que inserta aquí —y que escribe `contact.ficha`
 * y `contact.ficha_meta`— es `src/server/bot/ficha.ts`.
 *
 * Los valores son de calificación de un cliente ajeno: viven aquí (BD propia)
 * pero jamás en logs (Constitución I).
 */
export const fichaEvent = pgTable(
  "ficha_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** En qué conversación ocurrió (agente / bot); NULL = edición desde la UI. */
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    /** Escalar (o NULL = no había valor). */
    oldValue: jsonb("old_value").$type<string | number | boolean | null>(),
    /** Escalar (o NULL = borrado / intento sin valor guardable). */
    newValue: jsonb("new_value").$type<string | number | boolean | null>(),
    source: text("source", { enum: ["ia", "humano", "bot"] }).notNull(),
    /** Solo `source = "humano"`. */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome", {
      enum: ["aplicado", "ignorado_humano", "invalido"],
    }).notNull(),
    /** `FichaIgnoreReason` (src/lib/ficha-fields.ts); NULL si se aplicó. */
    reason: text("reason", {
      enum: [
        "candado_humano",
        "clave_desconocida",
        "no_la_llena_el_agente",
        "tipo",
        "opcion",
        "tope",
      ],
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ficha_event_org_contact_idx").on(
      t.organizationId,
      t.contactId,
      t.createdAt
    ),
  ]
);

/**
 * 02/05 — Bitácora de escalamientos a humano: append-only. Una fila por cada
 * TRANSICIÓN a handoff (`conversation.handoff_at` de NULL a una fecha). El
 * estado de `conversation` se limpia al reactivar y se sobrescribe; esta
 * tabla es el historial que permite contar escalamientos por motivo y periodo.
 *
 * Regla dura: la ÚNICA puerta que inserta aquí es `markHandoff`
 * (`src/server/inbox/handoff.ts`), en la misma transacción que el UPDATE de
 * `conversation`. Nadie actualiza ni borra (un unit test de vigilancia lo
 * exige). Las conversaciones `is_test` (Laboratorio) jamás se registran.
 *
 * `created_at` ES la hora del evento (no hay `occurred_at`): las filas
 * sembradas por la migración 0017 llevan `created_at = handoff_at` y
 * `approximate = true` (cuentan para totales, jamás para promedios de tiempo).
 */
export const conversationHandoffEvent = pgTable(
  "conversation_handoff_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** Hoy solo "opened"; "closed" queda reservado (reactivar no registra). */
    kind: text("kind", { enum: ["opened", "closed"] }).notNull(),
    /** Motivo (catálogo de `conversation.handoffReason`); NULL en "closed". */
    reason: text("reason", { enum: HANDOFF_REASONS }),
    /** Nota libre recortada (`toHandoffNote`), igual que `handoff_note`. */
    note: text("note"),
    /**
     * Quién escaló: el agente in-process, el cerebro externo (`/api/bot`),
     * el dueño desde el teléfono (manual_reply), un operador, el sistema o
     * la siembra de la migración.
     */
    source: text("source", { enum: HANDOFF_SOURCES }).notNull(),
    /** NULL = no lo hizo una persona con sesión en el CRM. */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** true = sembrada en la migración (hora aproximada). */
    approximate: boolean("approximate").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("hoe_org_created_idx").on(t.organizationId, t.createdAt),
    index("hoe_org_reason_idx").on(t.organizationId, t.reason),
  ]
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** ID de WhatsApp — UNIQUE (idempotencia). Nullable en salientes de prueba. */
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull().default("text"),
    text: text("text"),
    status: text("status", {
      enum: ["pending", "sent", "delivered", "read", "failed"],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * 008 — Origen del saliente: IA (bot), operador del CRM, manual desde la
     * app de WhatsApp Business del teléfono (echo), o plantilla. En entrantes
     * queda el default y la UI lo ignora.
     */
    origin: text("origin", {
      enum: ["ai", "operator", "manual", "template"],
    })
      .notNull()
      .default("operator"),
    /** 008 — Adjunto del mensaje (imagen, doc, ubicación…), si lo hay. */
    mediaAssetId: text("media_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    waTimestamp: timestamp("wa_timestamp"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_org_conv_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt
    ),
    // 02: barrido por rango de fechas de toda la org (Reportes, migración 0017).
    index("message_org_created_idx").on(t.organizationId, t.createdAt),
  ]
);

/**
 * 008 — Adjuntos: archivo (imagen/video/audio/documento/sticker) copiado al
 * volumen local (`MEDIA_DIR`) o contenido estructurado (location/contacts) en
 * `payload`. 018: el disco es una CACHÉ de 30 días (`MEDIA_RETENTION_DAYS`):
 * después el binario se borra y la fila queda `expired` (constitución II:
 * sin S3/R2).
 */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contacts",
      ],
    }).notNull(),
    /** media id de Graph (entrantes/salientes subidos); NULL en location/contacts. */
    waMediaId: text("wa_media_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    caption: text("caption"),
    /** location {latitude, longitude, name?, address?} o contacts (subset). */
    payload: jsonb("payload"),
    /** Ruta relativa dentro de MEDIA_DIR; NULL si aún no descargado o no aplica. */
    storagePath: text("storage_path"),
    /**
     * 018: `expired` = el reloj de purga borró el binario (caché de 30 días);
     * `blocked` = la firma no pasó la política de archivos y el binario nunca
     * se guardó (`fetch_error` lleva la razón). Columna text: sin SQL.
     */
    fetchStatus: text("fetch_status", {
      enum: ["available", "pending", "failed", "expired", "blocked"],
    })
      .notNull()
      .default("pending"),
    fetchError: text("fetch_error"),
    /** 018: `in` = lo mandó el cliente; `out` = el negocio (CRM o echo). */
    direction: text("direction", { enum: ["in", "out"] })
      .notNull()
      .default("in"),
    /** 018: URL de origen de un entrante de Messenger/Instagram (CDN de Meta). */
    sourceUrl: text("source_url"),
    /**
     * 019: copia enviada desde el Catálogo; solo procedencia. `set null`: el
     * hilo conserva su copia aunque el archivo del catálogo se borre.
     */
    productFileId: text("product_file_id").references(() => productFile.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_asset_org_idx").on(t.organizationId, t.createdAt),
    index("media_asset_wa_media_idx").on(t.waMediaId),
  ]
);

export const metaCredentials = pgTable(
  "meta_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_credentials_org_uq").on(t.organizationId),
    // El webhook enruta por phone_number_id: debe ser único en la instancia.
    uniqueIndex("meta_credentials_phone_uq").on(t.phoneNumberId),
  ]
);

/**
 * 014 - Credenciales del canal de Instagram. Tabla explicita (no un jsonb
 * generico) porque unas credenciales tienen forma fija y conocida: asi
 * conservan tipado e indices. El token se cifra con los mismos helpers que el
 * de WhatsApp; un segundo mecanismo de cifrado seria un segundo mecanismo que
 * auditar.
 */
export const instagramCredentials = pgTable(
  "instagram_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] }).notNull(),
    /** IG_ID del perfil profesional: por el enruta el webhook. */
    igUserId: text("ig_user_id").notNull(),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Secreto HMAC de las entregas (Zernio); null en modo Meta. */
    webhookSecret: text("webhook_secret"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instagram_credentials_org_uq").on(t.organizationId),
    uniqueIndex("instagram_credentials_ig_user_uq").on(t.igUserId),
    index("instagram_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 017 - Credenciales del canal de Messenger: una Pagina de Facebook por
 * organizacion. Misma forma y mismo cifrado que las de Instagram. El token es
 * el de la Pagina (idealmente de un usuario del sistema, que no caduca).
 */
export const messengerCredentials = pgTable(
  "messenger_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Id de la Pagina: `entry[].id` del webhook, por el enruta la ingesta. */
    pageId: text("page_id").notNull(),
    pageName: text("page_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_credentials_org_uq").on(t.organizationId),
    uniqueIndex("messenger_credentials_page_uq").on(t.pageId),
  ]
);

export const agentProfile = pgTable(
  "agent_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    name: text("name").notNull().default("Asistente"),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    /**
     * 04 — Definición de los campos de la ficha (orden = orden del panel).
     * NULL = sin definición: ficha libre y el agente no llena nada.
     * Se valida con `fichaFieldsSchema` (src/lib/ficha-fields.ts).
     */
    fichaFields: jsonb("ficha_fields").$type<FichaFieldDef[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profile_org_uq").on(t.organizationId)]
);

export const kbEntry = pgTable(
  "kb_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["qa", "block"] }).notNull(),
    question: text("question"),
    answer: text("answer"),
    content: text("content"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("kb_org_idx").on(t.organizationId)]
);

export const template = pgTable(
  "template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    waTemplateId: text("wa_template_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_org_name_lang_uq").on(
      t.organizationId,
      t.name,
      t.language
    ),
  ]
);

export const agentTestRun = pgTable(
  "agent_test_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    score: integer("score"),
    error: text("error"),
    /**
     * 08 — Perfil + KB + personas + modelos al crear la corrida (RF-08-15).
     * Pesado: los listados NO lo seleccionan. NULL = corrida anterior a 08.
     */
    configSnapshot: jsonb("config_snapshot").$type<LabConfigSnapshot>(),
    /** 08 — Claves de las personas de la corrida (delta comparable). */
    personaKeys: jsonb("persona_keys").$type<string[]>(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Lock de concurrencia en BD: máximo 1 corrida activa por organización.
    uniqueIndex("test_run_org_running_uq")
      .on(t.organizationId)
      .where(sql`${t.status} = 'running'`),
    index("test_run_org_idx").on(t.organizationId, t.startedAt),
  ]
);

/* ============================================================
 * 015 — Motor de agenda (detrás de la bandera AGENDA)
 *
 * Las tablas se crean SIEMPRE, encendida o apagada la bandera: una tabla
 * vacía es inerte, y a cambio todas las instancias del mundo comparten la
 * misma estructura y la misma cadena de migraciones (ADR-001).
 * ============================================================ */

/** Configuración de la agenda del negocio: una fila por organización. */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `{"mon":[{"start":"09:00","end":"18:00"}]}` — hora de PARED, no UTC. */
    weeklyHours: jsonb("weekly_hours").notNull(),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    maxDaysAhead: integer("max_days_ahead").notNull().default(7),
    timezone: text("timezone").notNull().default("America/Mexico_City"),
    /**
     * Cómo se entrega la reunión. `enlace-fijo` no habla con nadie: es el
     * default y la razón de que encender la agenda no exija terceros.
     * Un fork agrega el suyo al catálogo del código sin tocar esta columna.
     */
    connector: text("connector").notNull().default("enlace-fijo"),
    /** Sala fija del conector `enlace-fijo`; null ⇒ citas sin link. */
    meetingLink: text("meeting_link"),
    /* ── 10 — Recordatorios de cita (contrato 10-0, migración 0018) ── */
    /** Apagado por defecto: activarlo exige plantilla aprobada y mapeo completo. */
    reminderEnabled: boolean("reminder_enabled").notNull().default(false),
    /**
     * Instante (puesto por JS) de la última transición apagado → encendido.
     * Solo se avisan recordatorios cuyo momento de envío (`scheduled_at −
     * offset`) sea ≥ esta fecha: encender no dispara una ráfaga sobre las
     * citas ya agendadas. Apagar no lo borra; re-encender lo reescribe.
     */
    reminderEnabledAt: timestamp("reminder_enabled_at"),
    /** Plantilla aprobada de WhatsApp; borrarla deja el ajuste sin plantilla. */
    reminderTemplateId: text("reminder_template_id").references(
      () => template.id,
      { onDelete: "set null" }
    ),
    /** Anticipaciones en minutos (1 o 2 valores, 60..4320). */
    reminderOffsetsMinutes: jsonb("reminder_offsets_minutes")
      .$type<number[]>()
      .notNull()
      .default([1440]),
    /** Campo del catálogo por cada `{{n}}` (índice = n − 1). */
    reminderVariables: jsonb("reminder_variables")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_settings_org_uq").on(t.organizationId)]
);

/**
 * La cita. Una sola tabla para sesiones y bloqueos manuales: un bloqueo es
 * una cita sin contacto que ocupa agenda igual.
 */
export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["session", "block"] })
      .notNull()
      .default("session"),
    status: text("status", {
      enum: ["agendada", "realizada", "no_show", "cancelada"],
    })
      .notNull()
      .default("agendada"),
    source: text("source", { enum: ["manual", "ai"] })
      .notNull()
      .default("manual"),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => lead.id, { onDelete: "set null" }),
    /** Instante UTC. El horario semanal es de pared; esto ya está resuelto. */
    scheduledAt: timestamp("scheduled_at").notNull(),
    /** Capturada al crear: cambiar la configuración no reescribe el pasado. */
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * Con qué conector nació la ENTREGA. Reprogramar y cancelar hablan con
     * ESTE, no con el activo: si el negocio cambia de proveedor, las citas ya
     * confirmadas siguen viviendo donde se crearon.
     */
    connector: text("connector"),
    /** Id de la reunión/evento en el proveedor; null en `enlace-fijo`. */
    externalRef: text("external_ref"),
    /**
     * El link que se le dio al cliente. Se COPIA, no se lee de la
     * configuración: la cita es un hecho histórico, no una vista del presente.
     */
    meetingLink: text("meeting_link"),
    /**
     * El proveedor falló al crear la reunión. La cita existe igual —un tercero
     * caído no cuesta la conversión— y el operador reintenta desde "Citas".
     */
    linkPending: boolean("link_pending").notNull().default(false),
    /** Conversación del Laboratorio: jamás llama a un conector real. */
    isTest: boolean("is_test").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_org_when_idx").on(t.organizationId, t.scheduledAt),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    /**
     * Anti doble-booking ATÓMICO. La re-validación al confirmar deja una
     * ventana entre leer y escribir; esto la cierra en la BASE: dos
     * confirmaciones simultáneas del mismo instante no pueden ganar las dos, y
     * la perdedora recibe un 23505 que el servicio traduce a `slot_taken` con
     * alternativas frescas. Las citas de prueba quedan fuera: no consumen la
     * agenda real.
     */
    uniqueIndex("booking_org_active_slot_uq")
      .on(t.organizationId, t.scheduledAt)
      .where(
        sql`${t.status} in ('agendada','realizada') and ${t.isTest} = false`
      ),
  ]
);

/**
 * La memoria de lo ofrecido. Es lo que hace verificable el requisito
 * innegociable: sin fila aquí, no hay reserva.
 *
 * Vive en el CRM y no en quien conduce la conversación porque Vocero promete
 * "conecta TU propio cerebro": con la garantía del lado del cliente, cualquier
 * cerebro podría reservar un instante que jamás se ofreció y el CRM lo
 * aceptaría.
 */
export const offeredSlot = pgTable(
  "offered_slot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    /** La etiqueta EXACTA que se le mostró al cliente. */
    label: text("label").notNull(),
    offeredAt: timestamp("offered_at").notNull().defaultNow(),
  },
  (t) => [index("offered_slot_conv_idx").on(t.conversationId, t.startUtc)]
);

/**
 * 10 — Un recordatorio de cita: una fila por `(cita, anticipación, hora de la
 * cita)`. El UNIQUE de esa terna ES el claim atómico (`INSERT … ON CONFLICT DO
 * NOTHING RETURNING`): dos ticks simultáneos —o dos réplicas— no pueden enviar
 * dos veces (a lo sumo una vez, D-10-02).
 *
 * `scheduled_for` es la copia de `booking.scheduled_at` al reclamar: al
 * reprogramar, la clave cambia y nacen recordatorios nuevos; los de la hora
 * anterior quedan como historial.
 *
 * Todos los tiempos de la lógica (`claimed_at`, `sent_at`) los pone JS con el
 * reloj inyectado (`runReminderTick(now)`), nunca un `DEFAULT now()` de SQL:
 * así se prueba "interrumpido a los 10 min" sin esperar 10 min.
 *
 * Las citas `is_test` (Laboratorio) JAMÁS generan fila.
 */
export const bookingReminder = pgTable(
  "booking_reminder",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    bookingId: text("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade" }),
    /** Minutos antes de la cita (una de las anticipaciones configuradas). */
    offsetMinutes: integer("offset_minutes").notNull(),
    /** La hora de la cita (UTC, sin zona, igual que `booking.scheduled_at`). */
    scheduledFor: timestamp("scheduled_for").notNull(),
    /** Ver `BOOKING_REMINDER_STATUSES` (`src/lib/reminders.ts`). */
    status: text("status", { enum: BOOKING_REMINDER_STATUSES }).notNull(),
    /** Motivo de `skipped` (catálogo `BOOKING_REMINDER_SKIP_REASONS`). */
    reason: text("reason", { enum: BOOKING_REMINDER_SKIP_REASONS }),
    /** Texto legible del fallo (`failed`), p. ej. `interrumpido`. */
    error: text("error"),
    /** Plantilla con la que se intentó (la del ajuste en ese momento). */
    templateId: text("template_id").references(() => template.id, {
      onDelete: "set null",
    }),
    /** Mensaje persistido por `sendTemplate`: de aquí sale el estado de entrega. */
    messageId: text("message_id").references(() => message.id, {
      onDelete: "set null",
    }),
    /** Id de Meta del envío (copia cruda; la entrega se lee de `message`). */
    waMessageId: text("wa_message_id"),
    /** 1 = intento automático; 2 = el único reintento manual (D-10-02). */
    attempts: integer("attempts").notNull().default(1),
    /** Puesto por JS al reclamar (y al reintentar). Sin default a propósito. */
    claimedAt: timestamp("claimed_at").notNull(),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("booking_reminder_claim_uq").on(
      t.bookingId,
      t.offsetMinutes,
      t.scheduledFor
    ),
    index("booking_reminder_org_status_idx").on(
      t.organizationId,
      t.status,
      t.claimedAt
    ),
  ]
);

/**
 * 10 — Bitácora APPEND-ONLY de rondas de horarios ofrecidos (D-10-07): el
 * denominador de "oferta → cita". `offered_slot` no sirve porque se borra en
 * cada ronda. Se inserta DESPUÉS de confirmar la oferta, en try/catch: un
 * fallo del registro jamás revierte ni bloquea la oferta. Nadie actualiza ni
 * borra.
 */
export const agendaOfferLog = pgTable(
  "agenda_offer_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** Copia de `conversation.is_test`: las métricas lo excluyen. */
    isTest: boolean("is_test").notNull().default(false),
    /** Instantes UTC ofrecidos (ISO-8601), en el orden mostrado. */
    slots: jsonb("slots").$type<string[]>().notNull().default([]),
    slotCount: integer("slot_count").notNull(),
    /** Hora de la ronda (la pone JS; el default solo cubre inserciones a mano). */
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("agenda_offer_log_org_created_idx").on(t.organizationId, t.createdAt),
    index("agenda_offer_log_conv_idx").on(t.conversationId),
  ]
);

/**
 * Credenciales del conector Zoom (app Server-to-Server del propio negocio).
 * Tabla explícita como las de WhatsApp e Instagram: unas credenciales tienen
 * forma fija y conocida, y así conservan tipado e índices. El secreto se cifra
 * con los mismos helpers; un segundo mecanismo sería otro que auditar.
 */
export const zoomCredentials = pgTable(
  "zoom_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCipher: text("secret_cipher").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    /** `error` SE ESCRIBE cuando el proveedor rechaza la autenticación. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoom_credentials_org_uq").on(t.organizationId)]
);

/**
 * Credenciales del conector Google (Calendar + Meet), de la app de Google
 * Cloud del propio negocio. DOS secretos cifrados: el client secret y el
 * refresh token pegado una sola vez.
 */
export const googleCredentials = pgTable(
  "google_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretIv: text("client_secret_iv").notNull(),
    clientSecretTag: text("client_secret_tag").notNull(),
    refreshTokenCipher: text("refresh_token_cipher").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenTag: text("refresh_token_tag").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_credentials_org_uq").on(t.organizationId)]
);

export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentTestRun.id, { onDelete: "cascade" }),
    persona: text("persona").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    transcript: jsonb("transcript"),
    veredicto: text("veredicto", { enum: ["verde", "amarillo", "rojo"] }),
    hallazgos: jsonb("hallazgos"),
    /**
     * 04 — Chequeo determinista de llenado de la ficha por persona. Aparte de
     * `transcript` (que alimenta al juez) y fuera del score: informativo.
     */
    fichaCheck: jsonb("ficha_check").$type<FichaCheck>(),
    /** 08 — La persona tal como corrió (sobrevive a ediciones y archivado). */
    personaSnapshot: jsonb("persona_snapshot").$type<LabPersonaSnapshot>(),
    status: text("status", {
      enum: ["pending", "running", "done", "judge_failed"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("test_case_run_idx").on(t.runId)]
);

/* ============================================================
 * 08 — Laboratorio por cliente
 * ============================================================ */

/**
 * Personas guionadas del Laboratorio, por organización. `key` es un slug
 * ESTABLE: el juez y el ai-mock despachan por ella y `agent_test_case.persona`
 * la guarda. Borrar = archivar (`archived_at`). La siembra va en código
 * (`ensureSeedPersonas`), no en la migración.
 */
export const labPersona = pgTable(
  "lab_persona",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    objetivo: text("objetivo").notNull().default(""),
    rasgos: text("rasgos"),
    /** 1..8 mensajes; el primero es el mensaje inicial. */
    guion: jsonb("guion").$type<string[]>().notNull(),
    criteriosExito: text("criterios_exito"),
    contactName: text("contact_name").notNull(),
    /** Sintético (`52100000…`), lo genera el servidor; jamás del usuario. */
    phone: text("phone").notNull(),
    seed: jsonb("seed").$type<LabPersonaSeedData>(),
    expectFicha: jsonb("expect_ficha")
      .$type<LabExpectFichaRule[]>()
      .notNull()
      .default([]),
    /** `autos` | `neutro` si nació de la semilla (D-08-01); NULL = personalizada. */
    seedSet: text("seed_set", { enum: ["autos", "neutro"] }),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lab_persona_org_key_uq").on(t.organizationId, t.key),
    index("lab_persona_org_pos_idx").on(t.organizationId, t.position),
  ]
);

/**
 * Sugerencia del juez ya aplicada (RF-08-13). UNIQUE (test_case_id,
 * hallazgo_index): el INSERT … ON CONFLICT DO NOTHING es el candado de
 * idempotencia, en la MISMA transacción que el efecto (KB o perfil).
 */
export const labSuggestionApplication = pgTable(
  "lab_suggestion_application",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    testCaseId: text("test_case_id")
      .notNull()
      .references(() => agentTestCase.id, { onDelete: "cascade" }),
    hallazgoIndex: integer("hallazgo_index").notNull(),
    target: text("target", { enum: ["kb", "profile"] }).notNull(),
    /** Solo `profile`: tone | escalationRules | instructions. */
    field: text("field", {
      enum: ["tone", "escalationRules", "instructions"],
    }),
    kbEntryId: text("kb_entry_id").references(() => kbEntry.id, {
      onDelete: "set null",
    }),
    appliedText: text("applied_text").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lab_suggestion_case_hallazgo_uq").on(
      t.testCaseId,
      t.hallazgoIndex
    ),
    index("lab_suggestion_org_idx").on(t.organizationId),
  ]
);

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API
 * (detrás de la bandera ATRIBUCION)
 * ============================================================ */

/**
 * De qué anuncio vino una conversación. El primer referral gana: el UNIQUE de
 * abajo es lo que vuelve idempotente la captura ante los reintentos de Meta,
 * en vez de un "consulta y luego inserta" que dos webhooks simultáneos
 * ganarían los dos.
 */
export const adAttribution = pgTable(
  "ad_attribution",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /**
     * El identificador del clic en el anuncio. Es la llave de TODO: sin él no
     * hay nada que reportarle a Meta. Nullable porque hay referrals sin clid.
     */
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    /**
     * Payload íntegro del referral. Es la póliza contra "Meta agregó un campo":
     * nada se pierde y un fork puede pintar el creativo sin migrar nada.
     */
    raw: jsonb("raw").notNull(),
    /**
     * 020 — Miniatura del creativo, copiada del CDN de Meta al llegar (su URL
     * caduca en días). UNA por `source_id`: las conversaciones del mismo
     * anuncio comparten el asset. `set null`: borrar el adjunto deja la
     * tarjeta sin imagen, no apuntando a nada. La purga de 30 días no toca un
     * asset referenciado aquí (`src/server/media/purge.ts`).
     */
    imageAssetId: text("image_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_attribution_org_conversation_uq").on(
      t.organizationId,
      t.conversationId
    ),
    index("ad_attribution_org_contact_idx").on(t.organizationId, t.contactId),
    // 020: la miniatura se busca por anuncio (una por source_id).
    index("ad_attribution_org_source_idx").on(t.organizationId, t.sourceId),
  ]
);

/**
 * Cada intento de reportarle un desenlace a Meta. Las filas `skipped` no son
 * basura: son la respuesta a "¿por qué este lead no aparece en Meta?", que sin
 * ellas se contesta adivinando.
 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    attributionId: text("attribution_id").references(() => adAttribution.id, {
      onDelete: "set null",
    }),
    /** Nombre del catálogo de Meta tal cual (`QualifiedLead`, `Purchase`). */
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    /** Motivo legible: por qué se omitió, o qué contestó Meta. */
    error: text("error"),
    /**
     * Acuse del envío. Es la única referencia que Meta pide para rastrear un
     * evento de su lado; sin persistirla, un `sent` no se puede reclamar.
     */
    fbTraceId: text("fb_trace_id"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // El dedup ES este índice: la fila se inserta ANTES de hablar con Meta y
    // con ON CONFLICT DO NOTHING. Dos movimientos simultáneos del mismo lead
    // no pueden mandar dos compras.
    uniqueIndex("conversion_event_org_conv_name_uq").on(
      t.organizationId,
      t.conversationId,
      t.eventName
    ),
    index("conversion_event_org_created_idx").on(
      t.organizationId,
      t.createdAt
    ),
  ]
);

/** Conexión del negocio con su dataset de Meta (token cifrado en reposo). */
export const capiSettings = pgTable(
  "capi_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * Qué etapa significa "lead calificado" PARA ESTE NEGOCIO. Las etapas
     * sembradas de Vocero no incluyen ninguna con ese nombre y cada quien
     * renombra las suyas, así que se elige en vez de adivinarse. NULL = ese
     * evento no se emite. `set null` a propósito: borrar la etapa apaga el
     * evento, no rompe la configuración.
     */
    qualifiedStageId: text("qualified_stage_id").references(
      () => pipelineStage.id,
      { onDelete: "set null" }
    ),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capi_settings_org_uq").on(t.organizationId)]
);

/* ============================================================
 * 09 — Respuestas rápidas (catálogo de la organización)
 * ============================================================ */

/**
 * Textos oficiales del negocio que el equipo inserta con `/` en el
 * compositor. Los gestiona el Propietario; todos los leen. `shortcut` se
 * guarda en minúsculas (`^[a-z0-9_-]{1,32}$`) y es único por org.
 */
export const quickReply = pgTable(
  "quick_reply",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    shortcut: text("shortcut").notNull(),
    title: text("title").notNull(),
    /** 1-4096; admite {{nombre}}, {{nombre_completo}}, {{vendedor}}, {{negocio}}. */
    body: text("body").notNull(),
    /** Orden del selector y de los chips (ascendente). */
    position: integer("position").notNull().default(0),
    /**
     * 019: atajo ligado a un producto: escenifica sus archivos según
     * `attach` (FR-920). Ambos o ninguno (lo valida el store). `set null`:
     * borrar el producto deja el atajo como texto.
     */
    productId: text("product_id").references(() => product.id, {
      onDelete: "set null",
    }),
    attach: text("attach", { enum: ["images", "documents", "all"] }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("quick_reply_org_shortcut_uq").on(t.organizationId, t.shortcut),
    index("quick_reply_org_pos_idx").on(t.organizationId, t.position),
  ]
);

/* ============================================================
 * 019 — Catálogo de productos (categorías → productos → variantes)
 * ============================================================ */

/** Un solo nivel (FR-901). Borrarla deja sus productos sin categoría. */
export const productCategory = pgTable(
  "product_category",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("product_category_org_pos_idx").on(t.organizationId, t.position)]
);

/**
 * Producto (FR-902). `code` conserva sus mayúsculas; es único por org sin
 * distinguirlas (índice parcial sobre `lower(code)`). La unicidad CRUZADA con
 * `product_variant.code` no la da un índice: la verifica el store dentro de
 * la transacción (409 `duplicate_code`).
 */
export const product = pgTable(
  "product",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => productCategory.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    code: text("code"),
    /** Texto libre ("desde $589,900"), ≤ 60. */
    price: text("price"),
    description: text("description"),
    attributes: jsonb("attributes")
      .$type<ProductAttribute[]>()
      .notNull()
      .default([]),
    /** Inactivo: atenuado en Catálogo, fuera del compositor y los atajos. */
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_org_code_uq")
      .on(t.organizationId, sql`lower(${t.code})`)
      .where(sql`${t.code} IS NOT NULL`),
    index("product_org_pos_idx").on(t.organizationId, t.position),
  ]
);

/**
 * Variante de un producto (FR-903). `price` NULL = hereda el del producto;
 * sus `attributes` se muestran después de los del producto.
 */
export const productVariant = pgTable(
  "product_variant",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    price: text("price"),
    attributes: jsonb("attributes")
      .$type<ProductAttribute[]>()
      .notNull()
      .default([]),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_variant_org_code_uq")
      .on(t.organizationId, sql`lower(${t.code})`)
      .where(sql`${t.code} IS NOT NULL`),
    index("product_variant_org_product_pos_idx").on(
      t.organizationId,
      t.productId,
      t.position
    ),
  ]
);

/**
 * Imagen o documento del catálogo (FR-905). `variant_id` NULL = compartido
 * por todas las variantes. `kind` y `mime_type` salen de la FIRMA
 * (`inspectOutgoing`), nunca de lo que declara el navegador. Cada fila
 * recuerda dónde se guardó (`storage_provider` + `storage_key`, FR-912):
 * cambiar de proveedor no migra lo ya subido. La purga de 30 días no la toca.
 */
export const productFile = pgTable(
  "product_file",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    variantId: text("variant_id").references(() => productVariant.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: ["image", "document"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull(),
    storageProvider: text("storage_provider", {
      enum: ["local", "azure-blob"],
    }).notNull(),
    /** `{org}/catalog/{fileId}` (ver `catalogStorageKey`). */
    storageKey: text("storage_key").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("product_file_org_product_pos_idx").on(
      t.organizationId,
      t.productId,
      t.position
    ),
  ]
);

/**
 * Fase B — id reutilizable de un archivo del catálogo ya subido a Meta
 * (FR-942/943): media id de WhatsApp o `attachment_id` de Messenger. La
 * clave incluye la cuenta: reconectar otro número no reutiliza los ids del
 * anterior. Upsert por el UNIQUE; borrar/reemplazar el archivo los invalida.
 */
export const productFileUpload = pgTable(
  "product_file_upload",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    productFileId: text("product_file_id")
      .notNull()
      .references(() => productFile.id, { onDelete: "cascade" }),
    channel: text("channel", {
      enum: ["whatsapp", "messenger", "instagram"],
    }).notNull(),
    /** phone_number_id (WhatsApp) o page id (Messenger). */
    accountId: text("account_id").notNull(),
    remoteId: text("remote_id").notNull(),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_file_upload_file_channel_account_uq").on(
      t.productFileId,
      t.channel,
      t.accountId
    ),
    index("product_file_upload_org_idx").on(t.organizationId),
  ]
);

/* ============================================================
 * 022 — Archivo de conversaciones (núcleo, sin bandera)
 * ============================================================ */

/**
 * Ajustes de la Bandeja: una fila por organización. Sin fila = defaults
 * (auto-archivo apagado, 14 días). Solo el Propietario los cambia.
 */
export const inboxSettings = pgTable("inbox_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  autoArchiveEnabled: boolean("auto_archive_enabled").notNull().default(false),
  autoArchiveDays: integer("auto_archive_days").notNull().default(14),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
