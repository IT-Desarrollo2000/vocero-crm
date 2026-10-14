import { graphRequest, MetaApiError } from "@/lib/meta/client";

export type ConnectionCheck =
  | {
      ok: true;
      displayPhoneNumber: string;
      verifiedName: string | null;
    }
  | { ok: false; code: "invalid_token" | "meta_unavailable" | "meta_error"; message: string };

/**
 * Valida token↔número contra la Graph API SIN persistir nada (FR-040):
 * un GET del número con el token debe devolver su display_phone_number.
 */
export async function testConnection(
  phoneNumberId: string,
  token: string
): Promise<ConnectionCheck> {
  try {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      id: string;
    }>(`${phoneNumberId}?fields=display_phone_number,verified_name`, {
      token,
    });
    if (!res.display_phone_number) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta no devolvió el número: verifica que el Phone Number ID sea correcto",
      };
    }
    return {
      ok: true,
      displayPhoneNumber: res.display_phone_number,
      verifiedName: res.verified_name ?? null,
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        return {
          ok: false,
          code: "invalid_token",
          message:
            "El token no es válido o expiró. Verifica que corresponde a este número (modo directo: token de usuario del sistema; modo agencia: token entregado por tu backend).",
        };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Meta no está disponible en este momento; intenta de nuevo",
        };
      }
      return { ok: false, code: "meta_error", message: err.message };
    }
    throw err;
  }
}

/**
 * Suscribe la app a la WABA (necesario para recibir webhooks en modo
 * directo). No lanza: en modo agencia el override lo configura el backend de
 * la agencia y esta llamada puede no aplicar, así que el fallo se devuelve
 * para avisarlo en pantalla en vez de quedarse solo en el log.
 */
export async function subscribeAppToWaba(
  wabaId: string,
  token: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await graphRequest(`${wabaId}/subscribed_apps`, {
      method: "POST",
      token,
    });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[connect] subscribed_apps falló:", detail);
    return { ok: false, detail };
  }
}

export type WabaAccess =
  | { ok: true }
  | { ok: false; userName: string }
  | { ok: "unknown" };

/**
 * ¿El usuario dueño del token está ASIGNADO a la WABA? Un token puede leer el
 * número (p. ej. con business_management) y aun así no poder enviar: Meta
 * responde "Authorization Error" en cada envío. Solo dice `false` cuando lo
 * comprueba; si algo no se puede consultar (modo agencia, paginación, un
 * permiso que falta) devuelve "unknown" y no estorba.
 */
export async function checkWabaAccess(
  wabaId: string,
  token: string
): Promise<WabaAccess> {
  try {
    const me = await graphRequest<{ id?: string; name?: string }>(
      "me?fields=id,name",
      { token }
    );
    if (!me.id) return { ok: "unknown" };
    const waba = await graphRequest<{ owner_business_info?: { id?: string } }>(
      `${wabaId}?fields=owner_business_info`,
      { token }
    );
    const businessId = waba.owner_business_info?.id;
    if (!businessId) return { ok: "unknown" };
    const users = await graphRequest<{
      data?: { id: string; tasks?: string[] }[];
      paging?: { next?: string };
    }>(`${wabaId}/assigned_users?business=${businessId}&limit=100`, { token });
    if (!users.data) return { ok: "unknown" };
    if (users.data.some((u) => u.id === me.id)) return { ok: true };
    if (users.paging?.next) return { ok: "unknown" };
    return { ok: false, userName: me.name ?? me.id };
  } catch {
    return { ok: "unknown" };
  }
}
