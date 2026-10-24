# Guion E2E — US3: Agente de IA con acciones tipadas

> Conducido con Playwright (MCP) contra `pnpm dev` con ai-mock
> (`OPENROUTER_BASE_URL` → `/api/dev/ai-mock`) y `AGENT_COALESCE_MS=2000`.

## Preparación

1. En `/agent`: encender el toggle global y agregar una entrada P/R al KB
   ("¿Hacen envíos?" → "Sí, a todo México en 2-5 días").
   ✅ El contador de tamaño del KB refleja la entrada.

## Camino feliz

2. **Respuesta con IA (FR-021)**: inbound "¿hacen envíos a Guadalajara?".
   ✅ Tras el debounce llega UNA respuesta del agente marcada "IA" en el hilo.
3. **Agrupación (FR-024)**: enviar 2 mensajes seguidos (<2s entre ellos).
   ✅ El agente responde UNA sola vez al conjunto.
4. **move_stage (FR-021)**: inbound "me interesa, lo compro".
   ✅ Respuesta del agente + el lead aparece en "Interesado" en el kanban.
5. **Handoff por frase (FR-022/SC-006)**: inbound "quiero hablar con un humano".
   ✅ El cliente recibe el aviso fijo «Con gusto. Le/Te comunico con un
   asesor; …» (030) y nada más.
   ✅ Badge de atención humana visible en la conversación; la IA queda
   silenciada (mensajes posteriores NO reciben respuesta).
   ✅ "Reactivar IA" desde el panel vuelve a activar al agente.

## Caminos infelices

6. **Toggle global apagado (FR-023)**: apagar el agente → inbound → sin respuesta.
7. **"somos 4 personas"**: NO produce handoff (cubierto por unit test del
   patrón; verificado además con inbound en vivo).
8. **Sin token de IA (FR-026)**: pestañas Agente y Laboratorio muestran estado
   vacío explicativo con acciones deshabilitadas (verificado en el checkpoint
   de compose, donde el entorno arranca sin token).
