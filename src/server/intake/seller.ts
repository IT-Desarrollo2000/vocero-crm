import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { assignConversation } from "@/server/inbox/queries";
import {
  matchSeller,
  type SellerAssignment,
  type SellerMember,
} from "./seller-match";

/**
 * 036 — Asignación por el vendedor del Excel (lo puro, en `seller-match.ts`).
 */

export type { SellerAssignment } from "./seller-match";

/** Miembros de la organización con su nombre (scoped por organización). */
export async function listSellerMembers(
  organizationId: string
): Promise<SellerMember[]> {
  return getDb()
    .select({ userId: schema.member.userId, name: schema.user.name })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(scoped(schema.member.organizationId, organizationId));
}

/**
 * Asigna la conversación al vendedor del Excel SOLO si está libre
 * (`expect: "unassigned"`, sin `viewer`): nunca se le quita a quien ya la
 * tiene. Idempotente: repetirlo con la misma persona da `asignado` sin
 * evento. Publica `conversation.updated` solo si cambió.
 *
 * No avisa en la campana (`notifyChatAssigned`): no hay una persona que haga
 * la asignación (`actorUserId`) y una importación de 100 filas serían 100
 * avisos de golpe. El vendedor ve sus chats en «Mis chats».
 */
export async function assignToSeller(
  organizationId: string,
  conversationId: string,
  seller: string
): Promise<SellerAssignment> {
  const match = matchSeller(seller, await listSellerMembers(organizationId));
  if (match.kind === "none") return "vendedor_no_encontrado";
  if (match.kind === "ambiguous") return "ambiguo";

  const result = await assignConversation(organizationId, conversationId, {
    to: match.userId,
    expect: "unassigned",
  });
  switch (result.kind) {
    case "ok":
      if (result.changed) {
        publish(organizationId, {
          type: "conversation.updated",
          data: { conversation: { id: conversationId } },
        });
      }
      return "asignado";
    case "conflict":
      return "ya_asignada";
    case "invalid_assignee":
      // Lo quitaron del equipo entre la consulta y la asignación.
      return "vendedor_no_encontrado";
    case "not_found":
      return "error";
  }
}
