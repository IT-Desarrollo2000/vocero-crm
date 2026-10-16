/**
 * 016 — Si esta instancia atribuye anuncios y le reporta conversiones a Meta.
 *
 * Mismo trato que los canales opcionales (ADR-001) y la agenda (ADR-002): el
 * código viaja siempre en `main` y lo que decide si EXISTE para el usuario es
 * una variable de despliegue. Una instancia que no anuncia no ve esto por
 * ningún lado: ni pestaña de Ajustes, ni rutas, ni una credencial que pedir.
 *
 * La bandera también apaga la captura del IDENTIFICADOR DE CLIC, no solo el
 * envío. El `ctwa_clid` llega gratis en el webhook y guardarlo "por si acaso"
 * haría que encender la bandera meses después tuviera historia que reportar —
 * pero llenar una tabla con identificadores de clic de Meta en una instancia
 * que nunca pidió esa función rompe la promesa de ADR-001 por el lado que más
 * importa, el de los datos. El costo (encender atribuye de ahí en adelante) es
 * menor de lo que parece: la ventana de atribución de Meta se mide en días.
 *
 * 020 — El ANUNCIO DE ORIGEN (id, titular, texto, miniatura) ya NO depende de
 * la bandera: se guarda siempre, porque de qué anuncio llegó un lead es dato
 * del negocio, no de Meta (tarjeta, etiqueta y filtro de la Bandeja). Lo único
 * que la bandera decide en la captura es el `ctwa_clid`, en la columna y
 * dentro del `raw` (`anuncioParaGuardar`, `src/server/attribution/store.ts`).
 * No es un descuido: no "corrijas" la ingesta para volver a cortar ahí.
 *
 * La migración se aplica siempre: unas tablas vacías son inertes, y a cambio
 * todas las instancias comparten la misma estructura.
 */

/** Valores que cuentan como "encendida". Cualquier otra cosa, apagada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseAtribucionFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Se lee de `process.env` directo, no por `getEnv()`, igual que
 * `agendaEnabled()` e `isMockEnabled()`: preguntar si una feature existe no
 * puede depender de que TODO el entorno valide. La ingesta de un mensaje
 * consulta esta bandera, y un entorno a medio configurar debe degradar —no
 * reventar— justo ahí.
 *
 * `ATRIBUCION` sí está declarada en el esquema de `lib/env.ts`: ahí viven su
 * documentación y su tipo. Lo que no pasa por el validador es esta consulta.
 */
export function atribucionEnabled(): boolean {
  return parseAtribucionFlag(process.env.ATRIBUCION);
}

/**
 * Respuesta para una superficie apagada. 404 y no 403 a propósito: si la
 * bandera está apagada, ese endpoint no existe en esta instancia — no hay nada
 * que revelar sobre él.
 */
export function atribucionDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
