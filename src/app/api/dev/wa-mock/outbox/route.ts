import { mockGuard } from "@/lib/dev-guard";
import { getWaMockState, resetWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  const state = getWaMockState();
  // 019 fase B: `uploads` va aparte para no alterar a quien cuenta el outbox.
  // 020 fase C: `subscriptions`, lo que el CRM pidió a `subscribed_apps`.
  return Response.json({
    outbox: state.outbox,
    uploads: state.uploads,
    subscriptions: state.subscriptions,
  });
}

export async function DELETE() {
  const guard = mockGuard();
  if (guard) return guard;
  resetWaMockState();
  return Response.json({ cleared: true });
}
