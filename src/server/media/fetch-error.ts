/**
 * 008/018 — Fallo al descargar un adjunto entrante (Graph de WhatsApp o CDN
 * de Messenger/Instagram). Vive aparte para que los dos descargadores lo
 * compartan sin importarse entre sí.
 */
export class MediaFetchError extends Error {
  /** true si la plataforma ya no tiene el archivo (expirado/borrado) — no reintentar. */
  gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "MediaFetchError";
    this.gone = gone;
  }
}
