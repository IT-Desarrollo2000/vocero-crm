import { describe, expect, it } from "vitest";
import { VIEWS } from "@/components/inbox/list-state";
import { INBOX_FILTERS, INBOX_VIEWS, parseView } from "@/server/inbox/list-query";

/**
 * 022 — Las vistas de la Bandeja viven en dos sitios (servidor y espejo
 * cliente de la URL). Si divergen, `?filter=archived` funcionaría en la API y
 * la página lo tiraría a `all` (o al revés).
 */
describe("vistas de la Bandeja: servidor ≡ cliente", () => {
  it("INBOX_VIEWS (servidor) = VIEWS (list-state)", () => {
    expect([...VIEWS].sort()).toEqual([...INBOX_VIEWS].sort());
  });

  it("toda vista es un filtro válido de ?filter= y parseView la conserva", () => {
    for (const v of INBOX_VIEWS) {
      expect(INBOX_FILTERS).toContain(v);
      expect(parseView(v).view).toBe(v);
    }
    expect(parseView("archived")).toEqual({
      view: "archived",
      mine: false,
      unassigned: false,
      closing: false,
    });
    expect(parseView("archivadas").view).toBe("all");
  });

  it("027: `mine` ya no es vista, pero filter=mine sigue valiendo (≡ assigned=me)", () => {
    expect(INBOX_VIEWS).not.toContain("mine");
    expect(VIEWS).not.toContain("mine");
    expect(parseView("mine")).toEqual({
      view: "all",
      mine: true,
      unassigned: false,
      closing: false,
    });
  });
});
