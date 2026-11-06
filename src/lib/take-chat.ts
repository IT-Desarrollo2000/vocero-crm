/**
 * 032 — «Tomar y responder»: la misma toma atómica que el Buzón
 * (`expect: "unassigned"`). La comparten Seguimiento y Contactos; si alguien
 * se adelantó, el motivo dice quién (o «Otro vendedor»).
 */
export type TakeResult = { ok: true } | { ok: false; message: string };

export async function takeChat(
  conversationId: string,
  userId: string,
  contactName: string
): Promise<TakeResult> {
  const res = await fetch(`/api/conversations/${conversationId}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, expect: "unassigned" }),
  }).catch(() => null);
  if (res?.ok) return { ok: true };
  if (!res) return { ok: false, message: "No se pudo tomar el chat: sin conexión con el servidor." };
  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; assignedTo?: { name?: string } };
  } | null;
  if (data?.error?.code === "already_assigned") {
    const who = data.error.assignedTo?.name;
    return {
      ok: false,
      message: who
        ? `${who} ya tomó el chat de ${contactName}.`
        : `Otro vendedor ya tomó el chat de ${contactName}.`,
    };
  }
  return { ok: false, message: data?.error?.message ?? "No se pudo tomar el chat." };
}
