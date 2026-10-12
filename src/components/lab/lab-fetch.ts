import { classifyLabError, type LabErrorOutcome } from "./lab-logic";

export type LabFetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; outcome: LabErrorOutcome };

/**
 * `fetch` JSON para `/api/lab/*`: red caída o respuesta no-ok → un
 * `LabErrorOutcome` legible (501 = "Disponible pronto"); nunca lanza.
 */
export async function labFetch<T>(
  url: string,
  init?: { method?: string; body?: unknown },
  fallback?: string
): Promise<LabFetchResult<T>> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(init.body),
        }
      : {}),
  }).catch(() => null);
  if (!res) {
    return {
      ok: false,
      status: 0,
      outcome: { kind: "error", message: "Sin conexión con el servidor" },
    };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, outcome: classifyLabError(res.status, body, fallback) };
  }
  return { ok: true, status: res.status, data: body as T };
}
