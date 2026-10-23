# 030 — IA del agente en Claude Haiku 5.5 y juez que ve el pase a humano

**Carril**: ciclo completo. Núcleo (adaptador LLM, agente, Laboratorio), sin
bandera y sin migración. Decisión de dirección del 23-oct-2026.

## Contexto
La prueba comparativa del Laboratorio (23-oct, BD aislada, config de prod,
9 corridas, juez Sonnet 5.5) dio, sin el caso `pide_humano`: MiniMax M3 56 ·
Haiku 5.5 64 · Sonnet 5.5 78 (con MiniMax de juez: 72 · 75 · 83). Haiku es
~3× más rápido en el p95 (4.1 s vs 12.3 s por llamada) y cuesta la mitad
(≈ $11 vs $20 USD/mes a 7,000 turnos). Dirección eligió **Haiku 5.5 por
costo y rapidez**, vía la **API directa de Anthropic** (sin intermediario).

## Decisiones del dueño (23-oct-2026)
1. Modelo del agente: `claude-haiku-5-5`.
2. Ruta: el **endpoint compatible con OpenAI** de Anthropic
   (`https://api.anthropic.com/v1/chat/completions`). El conector nativo
   (`/v1/messages`) se evaluó y, con Haiku, no compensa: ahorraría ≈ $3–4/mes
   de caché y ~3 % de reintentos, contra 2–3 días y una enmienda del
   principio II. Se reconsidera si Anthropic retira el compatible o si se
   pasa a Sonnet. El adaptador sigue siendo «OpenRouter-compatible»: la
   constitución no cambia.
3. Corregir de una vez el falso negativo del Laboratorio: el juez no ve el
   pase a humano.

## Hallazgos de las sondas al endpoint compatible (Haiku 5.5)
- `max_tokens` no es obligatorio (lo pone el servidor).
- `thinking: {"type":"disabled"}` SÍ se respeta: ~1.7 s vs ~3.2 s y la mitad
  de tokens de salida. `output_config.effort` y `reasoning_effort` se ignoran.
- Historial que **termina** en `assistant` → **400** ("This model does not
  support assistant message prefill"). Que **empiece** en `assistant` está bien.
- Sonnet 5.5 rechaza `thinking: disabled` (400): el cuerpo extra no puede ser
  el mismo para agente y juez.

## Resultado de la verificación (23-oct-2026)
Con el razonamiento apagado Haiku cae de 64 a 50 en el Laboratorio y a veces
contesta texto plano en los 3 intentos (handoff `error`). Producción va con
el razonamiento por defecto (p50 2.2 s / p95 3.4 s por llamada) y sin cuerpo
extra; US-1 queda como capacidad configurable.

## Historias

### US-1 — El agente corre en Haiku sin razonamiento, configurable por entorno
- Nueva variable `OPENROUTER_EXTRA_BODY` (objeto JSON) que se mezcla en el
  cuerpo de las llamadas del agente; `OPENROUTER_JUDGE_EXTRA_BODY` para las
  del juez. Si no hay `OPENROUTER_JUDGE_MODEL` (el juez usa el modelo del
  agente), el juez hereda `OPENROUTER_EXTRA_BODY`.
- Ninguna de las dos puede pisar `model` ni `messages`. JSON inválido o que
  no sea objeto → error de arranque claro (como el resto de `env.ts`).
- Sin las variables, el cuerpo es exactamente el de hoy (`{model, messages}`).

### US-2 — Un historial que termina en saliente no tumba el turno
- Caso real: el cliente manda dos mensajes seguidos mientras el agente
  piensa; el agente contesta el primero y el turno re-encolado ve su propia
  respuesta al final. También: un asesor escribió durante la espera.
- Si el último mensaje del historial es `assistant`, se agrega al final un
  mensaje de rol `user` etiquetado como **aviso del sistema** (no lo escribió
  el cliente) que pide revisar si queda algo sin responder y, si no, elegir
  `none`. No se guarda en BD ni lo ve el regex de handoff.
- Sin este caso (el historial ya termina en `user`), nada cambia.

### US-3 — El juez del Laboratorio ve el pase a humano
- La conversación de cada caso informa al juez si terminó en un pase a
  asesor, con su motivo y nota.
- Reglas para el juez: un pase real tras pedirlo el cliente es un escalado
  correcto aunque el agente no haya escrito nada; un pase con motivo `error`
  es una falla técnica del agente (al menos amarillo).
- Las calificaciones del Laboratorio dejan de ser comparables con las
  anteriores a este cambio (se anota en el reporte).

## Fuera de alcance
- Conector nativo `/v1/messages`, caché y salida estructurada.
- Que el cliente reciba un mensaje cuando el CRM lo pasa a un asesor por
  frase («quiero hablar con un humano»): hoy no recibe nada. Es decisión de
  producto, se reporta aparte.
- Registro de tokens por llamada en BD.
