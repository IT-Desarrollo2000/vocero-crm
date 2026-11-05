# 031 — Guía para vendedores dentro del CRM + ayudas en pantalla

**Carril**: ciclo completo. Núcleo, sin bandera, sin migración y sin API nueva.
Decisión del dueño del 5-nov-2026.

## Contexto
Piden un tutorial para el equipo de ventas (poco técnico, trabaja en laptop,
sin cuenta de claude.ai) para que aproveche plantillas, ventana de 24 h,
documentos, respuestas rápidas, catálogo, etc. sin enredarse. Se descartaron
artefacto (pide cuenta) y video (por ahora). El link se manda por WhatsApp.

## Decisiones del dueño (5-nov-2026)
1. Opción 1 + 5: página **Ayuda** dentro del CRM + botones «?» en pantalla.
2. Trato **tú**. El sistema se nombra con el **nombre de la instancia**
   (`branding.name`).
3. ~~Botones «?»~~ → **descartados** (5-nov, mismo día): la pantalla debe guiar sola. Diseño aprobado en Claude Design: https://claude.ai/artifact/VA8A8xWUGAjqC2qZpXGC58 (6 pantallas).
4. Al terminar y verificar: **desplegar a producción** y entregar el link.
5. Sin agrupar la lista por secciones (toca el keyset de la Bandeja): se usan etiquetas por fila y el resumen «lo que te toca» lleva a las vistas que ya existen.
6. IA: cuando el vendedor empieza a escribir con la IA encendida, **se le pregunta** si la pausa (no se pausa sola).

## Historias
- **US-1 — El link de WhatsApp llega a la guía.** Un vendedor sin sesión abre
  `https://<dominio>/ayuda`, inicia sesión y aterriza en `/ayuda` (hoy cae en
  `/inbox`). Vale para cualquier ruta interna (p. ej. `/inbox?contact=…`).
  Un `next` externo o malformado (`//evil`, `https://…`, `/\evil`) se ignora
  y se va a `/inbox` (sin redirección abierta).
- **US-2 — Guía por situaciones.** `/ayuda` (cualquier rol con sesión, enlace
  en el menú junto a «Ajustes») muestra temas como tarjetas: situación →
  pasos cortos con captura → «¿Y si…?». Cada tema tiene ancla
  (`/ayuda#plantillas`). Los textos citan las etiquetas reales de la pantalla.
  Lo que es de módulo opcional solo aparece si el módulo está encendido
  (Citas → `AGENDA`; Instagram/Messenger → `CHANNELS`).
- **US-3 — Pantallas que se explican solas** (sin tooltips). Según el diseño aprobado: (a) composer con tiempo restante visible, respuestas rápidas rotuladas y menú «Adjuntar» con tipos y límites ANTES de elegir archivo; (b) ventana cerrada en 3 pasos (elige mensaje → completa espacios con contexto → revisa y envía, con vista previa y motivo si falta algo); (c) sin plantillas: estado vacío con los siguientes pasos; (d) franja «quién responde» bajo la cabecera del chat (IA / tú / pidió una persona) con «Atender yo» y «Devolver a la IA», y pregunta en línea al empezar a escribir con la IA encendida; (e) pestañas con descripción visible y «Tomar» por fila en el Buzón; (f) sin chat abierto, resumen «lo que te toca ahora» con contadores existentes; (g) página Ayuda con el estilo del diseño.

## Fuera de alcance
- Videos, tour guiado, ayudas que se ocultan, contenido editable desde la UI.
- Cambiar los chips de plantilla con ventana abierta (pegan el texto como
  mensaje libre, no envían plantilla de Meta). La guía lo explica; cambiarlos
  es otra decisión de producto.

## Criterios de aceptación
- CA-1: sin sesión, `/ayuda` → login → `/ayuda`. `next` inválido → `/inbox`.
- CA-2: un Vendedor ve `/ayuda` con los temas; nada de lo exclusivo del
  Propietario se le presenta como algo que él puede hacer (se le dice «pídele
  al propietario»).
- CA-3: con `AGENDA` apagada no aparece el tema de citas; con `CHANNELS` sin
  instagram/messenger no aparecen sus filas/párrafos.
- CA-4: los estados (a)–(f) de US-3 se ven y funcionan; ningún «?» queda en la UI; «Atender yo» deja el chat a tu nombre con la IA en pausa; «No, que siga» no vuelve a preguntar en ese chat durante la sesión.
- CA-5: capturas reproducibles con datos ficticios (script), a 1366×768.
- CA-6: gate verde + `scripts/e2e-ayuda.mjs` verde.
