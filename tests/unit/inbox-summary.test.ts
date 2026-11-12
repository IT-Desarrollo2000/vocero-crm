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

/** 035 B — «N recordatorios para hoy (M vencidos)», tono acento, antes del Buzón. */
describe("summaryItems — recordatorios", () => {
  const counts = { human: 3, closing: 0, scopes: scopes(4) };
  const opts = { scope: "mine" as const, teamMode: true };

  it("con N > 0: la línea de acento, después de lo urgente y antes del Buzón", () => {
    const items = summaryItems(counts, opts, { today: 5, overdue: 2 });
    expect(items.map((i) => i.id)).toEqual(["waiting", "reminders", "inbox"]);
    const r = items.find((i) => i.id === "reminders")!;
    expect(r).toMatchObject({
      count: 5,
      title: "5 recordatorios para hoy (2 vencidos)",
      hint: "Ábrelos en Seguimiento › Pendientes.",
      tone: "accent",
    });
  });

  it("singular y sin vencidos", () => {
    expect(summaryItems(counts, opts, { today: 1, overdue: 0 }).find((i) => i.id === "reminders")?.title).toBe(
      "1 recordatorio para hoy"
    );
    expect(summaryItems(counts, opts, { today: 2, overdue: 1 }).find((i) => i.id === "reminders")?.title).toBe(
      "2 recordatorios para hoy (1 vencido)"
    );
  });

  it("con 0 (o sin datos) no aparece", () => {
    expect(summaryItems(counts, opts, { today: 0, overdue: 0 }).some((i) => i.id === "reminders")).toBe(false);
    expect(summaryItems(counts, opts, null).some((i) => i.id === "reminders")).toBe(false);
    expect(summaryItems(counts, opts).some((i) => i.id === "reminders")).toBe(false);
  });
});
