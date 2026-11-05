import { graphRequest, MetaApiError } from "@/lib/meta/client";

/**
 * Nombre de quien escribe por Messenger, para `resolveChannelProfileName`.
 *
 * 1. User Profile API (`/{psid}?fields=first_name,last_name`). Requiere
 *    "Business Asset User Profile Access"; sin esa función aprobada Meta
 *    responde al instante `code 100, error_subcode 33`.
 * 2. Si falla o viene vacío: la conversación de la Página con ese usuario
 *    (`/{pageId}/conversations?platform=messenger&user_id={psid}&fields=participants`),
 *    que solo pide los permisos que ya tiene la app (pages_messaging,
 *    pages_manage_metadata, pages_show_list). Se toma el participante cuyo
 *    `id` es el PSID: el otro es la propia Página y jamás se usa.
 *
 * En secuencia y no en paralelo: el rechazo del perfil regresa en una ida y
 * vuelta, así que el respaldo cabe de sobra en el tope de 5 s del resolver, y
 * cuando el perfil sí está aprobado no se gasta la segunda llamada. Si ambas
 * fallan devuelve null (el contacto queda con el respaldo del canal).
 */

type Graph = <T>(path: string, opts: { token: string }) => Promise<T>;

type ProfileResponse = { first_name?: string; last_name?: string };
type ConversationsResponse = {
  data?: Array<{
    participants?: { data?: Array<{ id?: string; name?: string }> };
  }>;
};

/** El nombre del participante que es el PSID; nunca el de la Página. */
export function participantName(
  res: ConversationsResponse | null | undefined,
  psid: string
): string | null {
  for (const conv of res?.data ?? []) {
    const p = conv.participants?.data?.find((x) => x.id === psid);
    const name = p?.name?.trim();
    if (name) return name;
  }
  return null;
}

export async function fetchMessengerName(input: {
  psid: string;
  pageId: string;
  token: string;
  graph?: Graph;
}): Promise<string | null> {
  const graph: Graph = input.graph ?? graphRequest;
  const opts = { token: input.token };

  try {
    const p = await graph<ProfileResponse>(
      `${input.psid}?fields=first_name,last_name`,
      opts
    );
    const name = [p?.first_name?.trim(), p?.last_name?.trim()]
      .filter(Boolean)
      .join(" ");
    if (name) return name;
  } catch {
    // Sin Business Asset User Profile Access (100/33) u otro fallo: sigue la
    // vía de conversaciones.
  }

  try {
    const q = new URLSearchParams({
      platform: "messenger",
      user_id: input.psid,
      fields: "participants",
    });
    const res = await graph<ConversationsResponse>(
      `${input.pageId}/conversations?${q.toString()}`,
      opts
    );
    return participantName(res, input.psid);
  } catch (err) {
    // Las dos vías fallaron: queda el respaldo. Solo el código de Meta, jamás
    // el token (ver "Problemas comunes" en docs/canales-instagram-messenger.md).
    const code = err instanceof MetaApiError ? ` (status ${err.status}, code ${err.code ?? "?"})` : "";
    console.warn(`[fb] no se pudo obtener el nombre por conversaciones${code}`);
    return null;
  }
}
