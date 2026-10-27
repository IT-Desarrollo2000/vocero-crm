import { describe, expect, it } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import { fetchMessengerName, participantName } from "@/server/messenger/profile";

/**
 * Nombre de Messenger: perfil primero y, sin Business Asset User Profile
 * Access (code 100, subcode 33), la conversación de la Página.
 */

const PSID = "2600000000000001";
const PAGE = "1099000000000001";

const sinPermiso = () =>
  new MetaApiError("Unsupported get request.", {
    status: 400,
    code: 100,
    type: "GraphMethodException",
    details: { error: { code: 100, error_subcode: 33 } },
  });

const conversaciones = (participants: Array<{ id: string; name: string }>) => ({
  data: [{ participants: { data: participants }, id: "t_1" }],
});

/** Graph de mentira: responde por ruta y registra las llamadas. */
function fakeGraph(handlers: {
  profile: () => unknown;
  conversations: () => unknown;
}) {
  const calls: string[] = [];
  const graph = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    const fn = path.startsWith(`${PAGE}/conversations`)
      ? handlers.conversations
      : handlers.profile;
    return (await fn()) as T;
  };
  return { graph, calls };
}

const run = (g: ReturnType<typeof fakeGraph>) =>
  fetchMessengerName({ psid: PSID, pageId: PAGE, token: "tok", graph: g.graph });

describe("fetchMessengerName", () => {
  it("perfil disponible → usa el perfil y no gasta la segunda llamada", async () => {
    const g = fakeGraph({
      profile: () => ({ first_name: "Ana", last_name: "López" }),
      conversations: () => {
        throw new Error("no debería llamarse");
      },
    });
    expect(await run(g)).toBe("Ana López");
    expect(g.calls).toEqual([`${PSID}?fields=first_name,last_name`]);
  });

  it("perfil 100/33 → toma el nombre de la conversación de la Página", async () => {
    const g = fakeGraph({
      profile: () => {
        throw sinPermiso();
      },
      conversations: () =>
        conversaciones([
          { id: PSID, name: "Futuracrm Testeracc" },
          { id: PAGE, name: "Futura - City Cars" },
        ]),
    });
    expect(await run(g)).toBe("Futuracrm Testeracc");
    expect(g.calls[1]).toBe(
      `${PAGE}/conversations?platform=messenger&user_id=${PSID}&fields=participants`
    );
  });

  it("elige al participante por id, nunca a la Página (aunque venga primero)", async () => {
    const g = fakeGraph({
      profile: () => {
        throw sinPermiso();
      },
      conversations: () =>
        conversaciones([
          { id: PAGE, name: "Futura - City Cars" },
          { id: PSID, name: "Cliente Real" },
        ]),
    });
    expect(await run(g)).toBe("Cliente Real");
  });

  it("solo la Página entre los participantes → null", async () => {
    const g = fakeGraph({
      profile: () => {
        throw sinPermiso();
      },
      conversations: () => conversaciones([{ id: PAGE, name: "Futura - City Cars" }]),
    });
    expect(await run(g)).toBeNull();
  });

  it("perfil vacío → cae a conversaciones", async () => {
    const g = fakeGraph({
      profile: () => ({ first_name: " ", last_name: "" }),
      conversations: () => conversaciones([{ id: PSID, name: "Por Conversación" }]),
    });
    expect(await run(g)).toBe("Por Conversación");
  });

  it("ambas fallan → null (queda el respaldo)", async () => {
    const g = fakeGraph({
      profile: () => {
        throw sinPermiso();
      },
      conversations: () => {
        throw new MetaApiError("boom", { status: 500 });
      },
    });
    expect(await run(g)).toBeNull();
  });

  it("ambas vacías → null", async () => {
    const g = fakeGraph({
      profile: () => ({}),
      conversations: () => ({ data: [] }),
    });
    expect(await run(g)).toBeNull();
  });
});

describe("participantName", () => {
  it("tolera respuestas raras sin lanzar", () => {
    expect(participantName(null, PSID)).toBeNull();
    expect(participantName({}, PSID)).toBeNull();
    expect(participantName({ data: [{}] }, PSID)).toBeNull();
    expect(
      participantName({ data: [{ participants: { data: [{ id: PSID, name: "  " }] } }] }, PSID)
    ).toBeNull();
  });
});
