import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HIDE_PASSWORD_LABEL,
  PasswordInput,
  SHOW_PASSWORD_LABEL,
} from "@/components/ui/password-input";

/**
 * 037 — Ojo para ver la contraseña. Vitest corre en `node` (sin DOM): aquí se
 * prueba el HTML inicial y dónde se usa; el alternar, el foco y el ocultarse
 * al enviar los conduce `scripts/e2e-ver-contrasena.mjs` en el navegador.
 */
const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function render(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(PasswordInput, { id: "pw", ...props }));
}

describe("PasswordInput (037)", () => {
  it("arranca oculta, con el botón «Mostrar contraseña»", () => {
    const html = render({ autoComplete: "current-password", required: true });
    expect(html).toContain('type="password"');
    expect(html).toContain('id="pw"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain(`aria-label="${SHOW_PASSWORD_LABEL}"`);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain(HIDE_PASSWORD_LABEL);
  });

  it("el botón no envía el formulario y no lleva tooltip", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).not.toMatch(/\stitle=/);
    expect(html).toContain("pr-10");
  });

  it("si el campo está deshabilitado, el botón también", () => {
    const html = render({ disabled: true });
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it("se usa en Login, Registro y Cuenta (los 3 campos)", () => {
    const count = (rel: string) => (read(rel).match(/<PasswordInput\b/g) ?? []).length;
    expect(count("src/app/(auth)/login/page.tsx")).toBe(1);
    expect(count("src/app/(auth)/register/page.tsx")).toBe(1);
    expect(count("src/components/settings/account-client.tsx")).toBe(3);
    for (const rel of [
      "src/app/(auth)/login/page.tsx",
      "src/app/(auth)/register/page.tsx",
      "src/components/settings/account-client.tsx",
    ]) {
      expect(read(rel), rel).not.toContain('type="password"');
    }
  });

  it("los tokens y secretos NO tienen ojo", () => {
    for (const rel of [
      "src/components/settings/connector-credentials.tsx",
      "src/components/settings/instagram-client.tsx",
      "src/components/settings/messenger-client.tsx",
      "src/components/settings/whatsapp-wizard.tsx",
      "src/components/settings/team-client.tsx",
    ]) {
      expect(read(rel), rel).not.toContain("PasswordInput");
    }
  });
});
