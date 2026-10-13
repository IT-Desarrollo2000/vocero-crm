import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { subscribe } from "@/server/events/bus";
import { canReceive, createDeliveryQueue } from "@/server/events/visibility";
import { canSeeConversation } from "@/server/inbox/visibility";

/**
 * Canal SSE de la bandeja (contrato sse.md).
 * Headers exactos + heartbeat ~25s para sobrevivir detrás de Caddy/Traefik.
 * El servidor no garantiza replay: el cliente hace catch-up con `since=`.
 */
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

export async function GET(req: Request) {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("No autenticado", { status: 401 });
    }
    throw err;
  }
  const { organizationId } = session;
  // El rol se toma al abrir la conexión; la asignación, por evento.
  const viewer = { userId: session.userId, role: session.role };

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup?.();
        }
      };

      send(`: conectado\n\n`);

      // 09 (RF-09-09): decisión por evento con la asignación vigente
      // (`decideDelivery`), en orden de llegada por conexión. Un error de BD
      // descarta ese evento; el stream sigue.
      const queue = createDeliveryQueue({
        viewer,
        deps: {
          canSee: (conversationId) =>
            canSeeConversation(organizationId, viewer, conversationId),
        },
        send: (event) =>
          send(
            `event: ${event.type}\n` +
              `id: ${Date.now()}\n` +
              `data: ${JSON.stringify(event.data)}\n\n`
          ),
      });

      const unsubscribe = subscribe(organizationId, (event) => {
        // Atajo síncrono por rol (lab.run); el resto lo decide la cola.
        if (!canReceive(event, viewer)) return;
        queue.push(event);
      });

      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        queue.close();
        unsubscribe();
        try {
          controller.close();
        } catch {
          // ya cerrado
        }
      };

      req.signal.addEventListener("abort", () => cleanup?.());
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
