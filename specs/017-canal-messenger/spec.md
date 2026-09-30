# 017 — Canal de Facebook Messenger (y endurecer los canales no-WhatsApp)

**Carril**: ciclo completo. Toca el modelo de datos (tabla nueva de
credenciales) y la superficie pública (webhook nuevo). Sigue
[ADR-001](../../docs/adr-001-canales-opcionales.md): el código viaja en main y
el canal se enciende con `CHANNELS=...,messenger`.

## Problema

Un negocio que atiende por WhatsApp e Instagram también recibe mensajes en su
Página de Facebook. Hoy esos mensajes viven fuera del CRM: el agente, el
pipeline y la ficha no los ven.

Al preparar el canal apareció además que la 014 dejó huecos que afectan a
cualquier canal que no sea WhatsApp:

- Con la ventana de 24 h cerrada, el compositor ofrece **plantillas de
  WhatsApp** en una conversación de Instagram. No pueden funcionar ahí.
- Adjuntos, ubicación, contactos y plantillas asumen credenciales de WhatsApp
  (`credentials!`) y revientan con un 500 en otro canal.
- La etiqueta `HUMAN_AGENT` solo vale **7 días** tras el último mensaje del
  cliente y requiere que Meta apruebe la función *Human Agent*; hoy se manda
  siempre fuera de ventana y su rechazo sale como un error genérico.
- Instagram no tiene pantalla de conexión ni cobertura en el self-test.

## Escenarios

1. **Recibir**: alguien escribe a la Página de Facebook; el mensaje aparece en
   la bandeja con el distintivo de Messenger y crea un solo contacto.
2. **Responder**: el operador responde desde la bandeja y llega a Messenger.
3. **Fuera de ventana**: entre 24 h y 7 días, la respuesta humana sale con la
   etiqueta de agente humano y el compositor lo dice; pasados 7 días el
   compositor explica que el canal no permite retomar la conversación.
4. **Conectar**: el operador conecta la Página (y la cuenta de Instagram)
   desde Ajustes; un token inválido o de otra Página se rechaza antes de
   guardarse.
5. **Convivir**: WhatsApp e Instagram siguen funcionando igual.

## Requisitos

- **FR-201** `messenger` es un canal del catálogo (`lib/channels.ts`). La
  columna `channel` es `text`: no cambia su SQL.
- **FR-202** La identidad de un contacto de Messenger es su PSID, guardada
  como `fb:<PSID>` en `wa_identity` (nombre de contrato publicado, FR-108).
- **FR-203** Credenciales en `messenger_credentials`: una Página por
  organización, `page_id` único, token de Página cifrado con AES-256-GCM.
  Hacia fuera solo salen sus últimos 4.
- **FR-204** Webhook `/api/webhooks/fb/[webhookToken]`: segmento secreto +
  firma `x-hub-signature-256` (`FB_APP_SECRET`, o `META_APP_SECRET` si es la
  misma app). Solo `object: "page"`. Idempotente por `mid` (`fb_<mid>`).
  Echos, entregas, lecturas, postbacks y eventos de handover se ignoran sin
  ruido.
- **FR-205** Salida: `POST {graph}/{page-id}/messages` con `recipient.id` y
  `messaging_type` `RESPONSE`, o `MESSAGE_TAG` + `HUMAN_AGENT` fuera de la
  ventana de 24 h.
- **FR-206** Capacidades declaradas: ventana 24 h, etiqueta de agente humano
  hasta 7 días, límite de 2000 caracteres, sin adjuntos salientes, sin acuses
  de entrega (el mensaje nace `sent`).
- **FR-207** Un canal cuya ventana de etiqueta humana (7 días) venció rechaza
  el envío con `window_closed` y un mensaje claro. Si Meta rechaza la
  etiqueta por falta de permiso, el operador recibe un mensaje que lo dice
  (no un error genérico).
- **FR-208** El DTO de conversación expone `replyMode`
  (`free` | `human_agent` | `template` | `closed`) calculado por canal; el
  compositor lo usa y **no** ofrece plantillas, adjuntos, ubicación ni
  contactos donde el canal no los permite.
- **FR-209** Adjuntos, estructurados y plantillas fuera de WhatsApp responden
  un error claro (4xx), nunca un 500.
- **FR-210** El agente IA NUNCA usa la etiqueta de agente humano: fuera de la
  ventana de 24 h hace handoff en cualquier canal (política de Meta).
- **FR-211** El Laboratorio sigue sin tocar ninguna API real (la aserción de
  `isTest` va ANTES del ruteo por canal).
- **FR-212** Pantallas `/settings/instagram` y `/settings/messenger`, que solo
  existen con su canal encendido (404 si no) y muestran la URL del webhook.
- **FR-213** Instagram con inicio de sesión de Instagram firma con el secreto
  de la app de Instagram: `IG_APP_SECRET` si existe, si no `META_APP_SECRET`.

## Criterios de éxito

- Self-test E2E con Instagram y Messenger encendidos: entrante crea un solo
  contacto con su canal, re-entrega idempotente, respuesta llega al mock con
  el destinatario correcto, etiqueta fuera de ventana, rechazo pasados 7 días,
  texto largo rechazado, token muerto → `reconnect_required`, adjunto → 4xx.
- Con los canales apagados: settings, webhooks y pantallas → 404.
- Sin regresión: la suite existente sigue verde. Gates: typecheck, lint, test,
  build.

## Constitution Check

- **I. Seguridad**: token de Página cifrado; firma HMAC en el webhook; nada
  de secretos en logs ni respuestas.
- **II. Soberanía**: Messenger es parte de la misma plataforma (Meta) que el
  núcleo, detrás de bandera, apagado por defecto; su fallo no afecta a
  WhatsApp.
- **III. Multi-tenancy**: `organization_id` NOT NULL en la tabla nueva.
- **IV. Idempotencia**: dedup por `mid`; migración re-ejecutable.
- Sandbox del Laboratorio intacto.

## Fuera de alcance

Adjuntos (entrantes y salientes), postbacks, botones, respuestas rápidas,
acuses de entrega y lectura, comentarios de la Página, handover protocol,
unir el mismo humano entre canales y el alta por Facebook Login (el token se
pega a mano, como en Instagram).
