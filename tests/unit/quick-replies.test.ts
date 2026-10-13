import { describe, expect, it } from "vitest";
import {
  findUnknownVars,
  firstName,
  matchQuickReplies,
  normalizeShortcut,
  quickReplyCreateSchema,
  quickReplyPatchSchema,
  renderQuickReply,
  slashQuery,
  unknownVariableMessage,
} from "@/lib/quick-replies";
import { isDuplicateShortcut } from "@/server/quick-replies";

/** 09 (T-09-11): funciones puras de respuestas rápidas. */

describe("renderQuickReply", () => {
  const ctx = {
    nombre: "María López",
    vendedor: "Ana",
    negocio: "Taller Sol",
  };

  it("{{nombre}} = primer nombre; {{nombre_completo}} = completo", () => {
    expect(
      renderQuickReply("Hola {{nombre}} ({{nombre_completo}}), soy {{vendedor}} de {{negocio}}.", ctx)
    ).toBe("Hola María (María López), soy Ana de Taller Sol.");
  });

  it("acepta el nombre por cualquiera de los dos campos", () => {
    expect(renderQuickReply("{{nombre}}|{{nombre_completo}}", { nombreCompleto: "Juan Pérez" })).toBe(
      "Juan|Juan Pérez"
    );
    expect(renderQuickReply("{{nombre}}", { nombre: "Luis" })).toBe("Luis");
  });

  it("tolera espacios dentro de las llaves y variables repetidas", () => {
    expect(renderQuickReply("{{ nombre }} y {{nombre}}", ctx)).toBe("María y María");
  });

  it("sin valor → vacío, espacios dobles colapsados y sin espacio huérfano antes de la coma", () => {
    expect(renderQuickReply("Hola {{nombre}}, abrimos de 9 a 6.", { nombre: "" })).toBe(
      "Hola, abrimos de 9 a 6."
    );
    expect(renderQuickReply("Hola  {{nombre}}  ¿cómo estás?", {})).toBe("Hola ¿cómo estás?");
  });

  it("conserva los saltos de línea", () => {
    expect(renderQuickReply("Hola {{nombre}}\n\nHorario: 9 a 6", ctx)).toBe(
      "Hola María\n\nHorario: 9 a 6"
    );
  });

  it("una variable desconocida se deja tal cual", () => {
    expect(renderQuickReply("Tel: {{telefono}}", ctx)).toBe("Tel: {{telefono}}");
  });

  it("variable final sin valor → sin espacio colgando", () => {
    expect(renderQuickReply("Hola {{nombre}}", { vendedor: "x" })).toBe("Hola");
  });

  it("es estable entre llamadas (el patrón global no arrastra lastIndex)", () => {
    for (let i = 0; i < 3; i++) {
      expect(renderQuickReply("{{nombre}}", ctx)).toBe("María");
    }
  });
});

describe("findUnknownVars / unknownVariableMessage", () => {
  it("detecta la desconocida y la nombra", () => {
    expect(findUnknownVars("Hola {{telefono}}")).toEqual(["telefono"]);
    expect(unknownVariableMessage(["telefono"])).toBe("Variable desconocida: {{telefono}}");
  });

  it("sin repetir, en orden; las válidas no cuentan", () => {
    expect(findUnknownVars("{{a}} {{nombre}} {{b}} {{a}} {{ negocio }}")).toEqual(["a", "b"]);
    expect(unknownVariableMessage(["a", "b"])).toBe("Variables desconocidas: {{a}}, {{b}}");
  });

  it("con espacios dentro de las llaves cuenta como la misma variable", () => {
    expect(findUnknownVars("{{telefono}} {{ telefono }} {{email}}")).toEqual(["telefono", "email"]);
  });

  it("cuerpo sin variables → []", () => {
    expect(findUnknownVars("Abrimos de 9 a 6")).toEqual([]);
  });
});

describe("slashQuery", () => {
  it("al inicio del campo", () => {
    expect(slashQuery("/hor", 4)).toEqual({ query: "hor", start: 0 });
    expect(slashQuery("/", 1)).toEqual({ query: "", start: 0 });
  });

  it("tras un espacio o salto de línea", () => {
    expect(slashQuery("hola /Hor", 9)).toEqual({ query: "hor", start: 5 });
    expect(slashQuery("hola\n/ub", 8)).toEqual({ query: "ub", start: 5 });
  });

  it('"1/2 kilo" no dispara', () => {
    expect(slashQuery("1/2 kilo", 3)).toBeNull();
    expect(slashQuery("a/b", 3)).toBeNull();
  });

  it("caret en medio: solo cuenta lo que hay antes del caret", () => {
    expect(slashQuery("/horario y más", 4)).toEqual({ query: "hor", start: 0 });
    expect(slashQuery("/horario y más", 10)).toBeNull();
  });

  it("no dispara con caracteres fuera del atajo", () => {
    expect(slashQuery("/hola!", 6)).toBeNull();
  });
});

describe("normalizeShortcut / firstName", () => {
  it("trim, sin barra inicial y en minúsculas", () => {
    expect(normalizeShortcut("  /Horario ")).toBe("horario");
    expect(normalizeShortcut("//PAGO_1")).toBe("pago_1");
  });

  it("primer nombre", () => {
    expect(firstName("  María   López ")).toBe("María");
    expect(firstName(null)).toBe("");
  });
});

describe("matchQuickReplies", () => {
  const list = [
    { shortcut: "ubicacion", title: "Dónde estamos", position: 0 },
    { shortcut: "horario", title: "Horario de atención", position: 1 },
    { shortcut: "pagos", title: "Formas de pago y horario de caja", position: 2 },
  ];

  it("prefijo de atajo primero, luego coincidencias por título; sin acentos", () => {
    expect(matchQuickReplies(list, "hor").map((r) => r.shortcut)).toEqual(["horario", "pagos"]);
    expect(matchQuickReplies(list, "DONDE").map((r) => r.shortcut)).toEqual(["ubicacion"]);
  });

  it("consulta vacía → todas en el orden recibido", () => {
    expect(matchQuickReplies(list, "").map((r) => r.shortcut)).toEqual([
      "ubicacion",
      "horario",
      "pagos",
    ]);
  });

  it("sin coincidencias → []", () => {
    expect(matchQuickReplies(list, "zzz")).toEqual([]);
  });
});

describe("esquemas Zod", () => {
  it("normaliza el atajo antes de validarlo", () => {
    const r = quickReplyCreateSchema.safeParse({ shortcut: " /Horario", title: "Horario", body: "x" });
    expect(r.success && r.data.shortcut).toBe("horario");
  });

  it("rechaza atajos inválidos y límites", () => {
    for (const shortcut of ["", "con espacio", "ñandú", "a".repeat(33)]) {
      expect(quickReplyCreateSchema.safeParse({ shortcut, title: "t", body: "b" }).success).toBe(false);
    }
    expect(
      quickReplyCreateSchema.safeParse({ shortcut: "a", title: "t".repeat(81), body: "b" }).success
    ).toBe(false);
    expect(
      quickReplyCreateSchema.safeParse({ shortcut: "a", title: "t", body: "b".repeat(4097) }).success
    ).toBe(false);
    expect(
      quickReplyCreateSchema.safeParse({ shortcut: "a", title: "t", body: "b", position: -1 }).success
    ).toBe(false);
  });

  it("PATCH exige al menos un campo", () => {
    expect(quickReplyPatchSchema.safeParse({}).success).toBe(false);
    expect(quickReplyPatchSchema.safeParse({ position: 3 }).success).toBe(true);
  });
});

describe("isDuplicateShortcut", () => {
  it("23505 del índice del atajo (directo o en cause)", () => {
    expect(isDuplicateShortcut({ code: "23505", constraint_name: "quick_reply_org_shortcut_uq" })).toBe(true);
    expect(isDuplicateShortcut({ cause: { code: "23505", constraint_name: "quick_reply_org_shortcut_uq" } })).toBe(true);
  });

  it("otro índice único u otro error → no", () => {
    expect(isDuplicateShortcut({ code: "23505", constraint_name: "quick_reply_pkey" })).toBe(false);
    expect(isDuplicateShortcut(new Error("x"))).toBe(false);
    expect(isDuplicateShortcut(null)).toBe(false);
  });
});
