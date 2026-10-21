# 026 — "Por atender" que dice la verdad (esperando vs. atendida)

**Carril**: ciclo completo, SIN bandera (es la Bandeja del núcleo). Migración 0027.

## Problema (queja de usuarios, 21-oct-2026)

La etiqueta "Por atender" no deja saber si un chat ya se atendió o todavía
falta. Causas verificadas en código:

1. La etiqueta sale de `conversation.handoff_at` y SOLO se limpia con
   "Reactivar IA" (`updateConversation` → `reactivate`). Un vendedor puede
   contestar diez mensajes y el chat sigue diciendo "Por atender".
2. La vista "Por atender" (`filter=human`) mezcla los escalados con los que
   tienen la IA apagada a mano; un chat con la IA apagada se queda ahí para
   siempre.

Es decir: la etiqueta describe el estado de la IA ("me hice a un lado"), no
el de la atención ("el cliente espera respuesta").

## Decisiones del dueño (21-oct)

- Implementar B + D, con C como extra (propuesta en la conversación):
  - **B**: entre los chats en manos de una persona (escalados o IA apagada),
    distinguir "Esperando respuesta" (el cliente espera) de "Atendida".
  - **D**: el tiempo de espera a la vista, ámbar antes del umbral y rojo a
    partir de él; umbral por defecto 1 h, configurable por el Propietario.
  - **C**: botón "Marcar como atendida", separado de "Reactivar IA", que al
    resolver pregunta si se devuelve a la IA o se sigue atendiendo a mano.
- Los chats con la IA apagada a mano (sin escalar) entran en el mismo flujo.

## Definiciones

- **En manos de una persona** (`needsHuman`, sin cambio): `handoff_at IS NOT
  NULL OR ai_enabled = false`.
- **Esperando desde** (`conversation.awaiting_since`, nueva): instante desde el
  que el cliente espera una respuesta. NULL = nadie le debe respuesta.
  - Un entrante lo fija si estaba NULL (no lo mueve si ya tenía valor: la
    espera cuenta desde el PRIMER mensaje sin contestar).
  - Lo limpia un saliente que atiende: del operador (texto, adjunto,
    catálogo, ubicación, contactos, plantilla enviada a mano), el eco del
    teléfono, la IA o el bot externo. Un saliente `failed` NO limpia.
  - NO lo limpian los automáticos: recordatorios de cita.
  - El escalamiento lo fija si estaba NULL (la IA contestó "te paso con un
    asesor" y escaló: el cliente espera a la persona desde ese momento),
    salvo el escalamiento por eco del teléfono (`manual_reply`), que ES una
    respuesta humana.
  - "Marcar como atendida" lo limpia.
- **Esperando respuesta** = en manos de una persona ∧ `awaiting_since IS NOT
  NULL`. **Atendida** = en manos de una persona ∧ `awaiting_since IS NULL`.
- **Atrasada** = esperando ∧ `now − awaiting_since ≥ umbral`.

## Historias

### US-1 — Saber de un vistazo si falta contestar (B + D)
- La fila de un chat en manos de una persona muestra UNA de dos etiquetas:
  - "Esperando · 25 min" (ámbar; roja si está atrasada), con la hora en que
    empezó la espera en el `title`.
  - "Atendida" (neutra, con palomita); `title` aclara si la IA está en pausa.
- Al contestar desde el CRM (o el teléfono, en WhatsApp), la fila pasa a
  "Atendida" sin recargar. Si el cliente vuelve a escribir, vuelve a
  "Esperando".
- La vista "Por atender" y su contador muestran SOLO las que esperan
  respuesta. El contador baja en cuanto alguien contesta.
- La etiqueta del tiempo avanza sola (reloj de la lista, 1 min).

### US-2 — Cerrar un caso sin tener que escribir (C)
- En el panel del contacto, un chat en manos de una persona con espera
  abierta o escalamiento abierto ofrece "Marcar como atendida".
- Al pulsarlo se elige: "Seguir atendiendo yo" (IA en pausa) o "Devolver a la
  IA". Ambas limpian la espera y cierran el escalamiento (`handoff_*` a
  NULL); la primera deja `ai_enabled=false`, la segunda `true`.
- "Reactivar IA" sigue existiendo, como hoy.

### US-3 — Umbral configurable (D)
- Ajustes → Bandeja (solo Propietario): "Marcar como atrasada tras N minutos"
  (5–1440, por defecto 60). Se aplica a todos los miembros.

## Fuera de alcance
- Reordenar la vista por antigüedad de la espera (keyset actual se queda).
- Distinguir en BD plantilla a mano vs. recordatorio para los reportes.
- Registrar eventos `closed` en `conversation_handoff_event`.
- Ecos de Instagram/Messenger (hoy se descartan: una respuesta desde esas
  apps no marca "Atendida").

## Criterios de aceptación
- CA-1: entrante a un chat escalado → "Esperando", cuenta en "Por atender".
- CA-2: el operador contesta → "Atendida", sale de "Por atender", contador −1.
- CA-3: el cliente vuelve a escribir → "Esperando" de nuevo, desde ese mensaje.
- CA-4: la IA contesta y escala en el mismo turno → "Esperando".
- CA-5: un recordatorio de cita no marca "Atendida"; un envío fallido tampoco.
- CA-6: eco del teléfono → "Atendida" (y la IA en pausa, como hoy).
- CA-7: "Marcar como atendida" → seguir yo: IA en pausa, "Atendida", sin
  tarjeta de escalamiento; devolver a la IA: fuera de la vista, IA activa.
- CA-8: espera ≥ umbral → etiqueta roja; cambiar el umbral en Ajustes lo
  refleja en la Bandeja.
- CA-9: migración re-ejecutable con backfill: escalados abiertos sin
  respuesta humana posterior quedan "Esperando"; los contestados, "Atendida".
