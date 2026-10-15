import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState, resetWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  const state = getWaMockState();
  // 019 fase B: `uploads` va aparte para no alterar a quien cuenta el outbox.
  return Response.json({ outbox: state.outbox, uploads: state.uploads });
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  resetWaMockState();
  return Response.json({ cleared: true });
}
