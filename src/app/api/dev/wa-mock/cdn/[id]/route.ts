import { mockGuard } from "@/lib/dev-guard";
import { mockDeclaredMime, mockMediaBytes } from "@/server/dev/wa-mock-media";

/**
 * 018 — CDN de Meta simulado: la `payload.url` de un adjunto entrante de
 * Messenger/Instagram en el self-test apunta aquí (el descargador solo
 * acepta este origin con los mocks encendidos). Sin token, como el real.
 *
 * El id decide los bytes (`src/server/dev/wa-mock-media.ts`): contiene `pdf`
 * → PDF, `exe` → ejecutable MZ, `html` → HTML con <script>, otro → JPEG. Un
 * id con `expired` responde 404, como una URL del CDN ya caducada.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = mockGuard();
  if (guard) return guard;
  const { id } = await ctx.params;
  if (id.includes("expired")) {
    return new Response("URL signature expired", { status: 404 });
  }
  const bytes = mockMediaBytes(id);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mockDeclaredMime(id),
      "content-length": String(bytes.byteLength),
    },
  });
}
