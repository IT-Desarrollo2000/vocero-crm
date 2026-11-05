import { describe, expect, it } from "vitest";
import { summaryItems } from "@/lib/inbox-summary";

/**
 * 031 — «Lo que te toca ahora» (sin chat abierto): solo contadores que ya
 * trae `/counts`, solo los que tienen algo, y el Buzón solo en modo equipo
 * fuera del Buzón.
 */

const scopes = (inbox: number) => ({
  inbox: { all: inbox, unread: 0 },
  mine: { all: 0, unread: 0 },
  team: { all: 0, unread: 0 },
});

describe("summaryItems", () => {
  it("los tres accesos, rotulados con el alcance activo", () => {
    const items = summaryItems(
      { human: 2, closing: 1, scopes: scopes(7) },
      { scope: "mine", teamMode: true }
    );
    expect(items.map((i) => [i.id, i.title])).toEqual([
      ["waiting", "2 clientes esperan respuesta en Mis chats"],
      ["closing", "A 1 chat en Mis chats se le cierra la ventana en menos de 2 h"],
      ["inbox", "7 chats en el Buzón sin tomar"],
    ]);
  });

  it("solo los que tienen N > 0; todo en 0 = lista vacía («Todo al día»)", () => {
    expect(
      summaryItems({ human: 0, closing: 0, scopes: scopes(0) }, { scope: "mine", teamMode: true })
    ).toEqual([]);
    expect(
      summaryItems({ human: 1, closing: 0, scopes: scopes(0) }, { scope: "mine", teamMode: true }).map(
        (i) => i.title
      )
    ).toEqual(["1 cliente espera respuesta en Mis chats"]);
  });

  it("en el Buzón (o sin equipo) no se repite el acceso al Buzón", () => {
    const inInbox = summaryItems(
      { human: 0, closing: 0, scopes: scopes(4) },
      { scope: "inbox", teamMode: true }
    );
    expect(inInbox).toEqual([]);
    const solo = summaryItems({ human: 3, closing: 0, scopes: scopes(4) }, { scope: null, teamMode: false });
    expect(solo.map((i) => i.title)).toEqual(["3 clientes esperan respuesta"]);
  });

  it("sin contadores todavía, nada", () => {
    expect(summaryItems(null, { scope: "mine", teamMode: true })).toEqual([]);
  });
});
