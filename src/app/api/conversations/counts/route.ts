import { apiError, withAuth } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * 06: contadores de la Bandeja (`ConversationCounts` de `src/lib/types.ts`)
 * con los MISMOS filtros que la lista (`q`, `stage`, `channel`, `assigned`),
 * siempre dentro de lo visible para quien pide. Capas y `teamMode`: ver
 * dev-tasks/06-paginacion-de-la-bandeja.md, "Contrato 06-0".
 *
 * STUB del contrato 06-0: lo implementa 06-A (`countConversations`).
 */
export const GET = withAuth(async () =>
  apiError(501, "not_implemented", "Contadores de la Bandeja: pendiente (06-A)")
);
