import { mockGuard } from "@/lib/dev-guard";
import { mockDeclaredMime, mockMediaBytes } from "@/server/dev/wa-mock-media";

/**
 * Binario de prueba del wa-mock (media proxy del bot). La metadata del mock de
 * Graph apunta aquí como la "url" efímera del adjunto.
 *
 * 018: bytes REALES según el id (`src/server/dev/wa-mock-media.ts`); el
 * content-type es el declarado, que a propósito puede mentir (`…html-pdf`).
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const guard = mockGuard();
  if (guard) return guard;
  const { id } = await ctx.params;
  return new Response(new Uint8Array(mockMediaBytes(id)), {
    headers: { "content-type": mockDeclaredMime(id) },
  });
}
