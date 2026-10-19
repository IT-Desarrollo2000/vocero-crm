import { describe, expect, it } from "vitest";
import { filterNavForRole } from "@/components/nav-items";
import { settingsTabsFor } from "@/components/settings/settings-tabs";
import {
  passwordChangeError,
  validatePasswordChange,
} from "@/components/settings/account-errors";

/**
 * UI por rol (dev-tasks/00, RF-00-05/06/16): qué ve cada quien en el menú y
 * en Ajustes, y los mensajes de "Mi cuenta". La autorización real vive en la
 * API y en las guardas de página; esto solo evita enseñar lo que da 404.
 */

const NAV = [
  { href: "/inbox" },
  { href: "/pipeline" },
  { href: "/bookings" },
  { href: "/contacts" },
  { href: "/catalog" },
  { href: "/agent", ownerOnly: true },
  { href: "/lab", ownerOnly: true },
];

describe("filterNavForRole", () => {
  it("Propietario ve todo, en el mismo orden", () => {
    expect(filterNavForRole(NAV, "owner").map((i) => i.href)).toEqual(
      NAV.map((i) => i.href)
    );
  });

  it("Vendedor no ve Agente ni Laboratorio, sí el Catálogo", () => {
    expect(filterNavForRole(NAV, "member").map((i) => i.href)).toEqual([
      "/inbox",
      "/pipeline",
      "/bookings",
      "/contacts",
      "/catalog",
    ]);
  });

  it("no muta la lista original", () => {
    const copy = [...NAV];
    filterNavForRole(NAV, "member");
    expect(NAV).toEqual(copy);
  });
});

describe("settingsTabsFor", () => {
  it("Vendedor: solo Mi cuenta, aunque las banderas estén encendidas", () => {
    expect(
      settingsTabsFor({
        role: "member",
        agenda: true,
        atribucion: true,
        instagram: true,
        messenger: true,
      })
    ).toEqual([{ href: "/settings/account", label: "Mi cuenta" }]);
  });

  it("Propietario sin banderas: negocio + Mi cuenta", () => {
    expect(settingsTabsFor({ role: "owner" }).map((t) => t.href)).toEqual([
      "/settings/whatsapp",
      "/settings/branding",
      "/settings/templates",
      "/settings/quick-replies",
      "/settings/inbox",
      "/settings/team",
      "/settings/account",
    ]);
  });

  it("Propietario con banderas: canales tras WhatsApp, agenda y anuncios al final", () => {
    expect(
      settingsTabsFor({
        role: "owner",
        agenda: true,
        atribucion: true,
        instagram: true,
        messenger: true,
      }).map((t) => t.href)
    ).toEqual([
      "/settings/whatsapp",
      "/settings/instagram",
      "/settings/messenger",
      "/settings/branding",
      "/settings/templates",
      "/settings/quick-replies",
      "/settings/inbox",
      "/settings/team",
      "/settings/calendar",
      "/settings/ads",
      "/settings/account",
    ]);
  });

  it("019 — Almacenamiento solo con el conector encendido, y nunca para el Vendedor", () => {
    expect(
      settingsTabsFor({ role: "owner" }).some((t) => t.href === "/settings/storage")
    ).toBe(false);
    const tabs = settingsTabsFor({ role: "owner", atribucion: true, almacenamiento: true });
    expect(tabs.map((t) => t.href).slice(-3)).toEqual([
      "/settings/ads",
      "/settings/storage",
      "/settings/account",
    ]);
    expect(tabs.map((t) => t.label).join(" ")).not.toMatch(/azure/i);
    expect(settingsTabsFor({ role: "member", almacenamiento: true })).toEqual([
      { href: "/settings/account", label: "Mi cuenta" },
    ]);
  });

  it("011 — Leads externos solo con LEADS_EXTERNOS, tras Anuncios, y nunca para el Vendedor", () => {
    expect(
      settingsTabsFor({ role: "owner" }).some((t) => t.href === "/settings/leads-externos")
    ).toBe(false);
    const tabs = settingsTabsFor({ role: "owner", atribucion: true, leadsExternos: true });
    expect(tabs.map((t) => t.href).slice(-3)).toEqual([
      "/settings/ads",
      "/settings/leads-externos",
      "/settings/account",
    ]);
    expect(settingsTabsFor({ role: "member", leadsExternos: true })).toEqual([
      { href: "/settings/account", label: "Mi cuenta" },
    ]);
  });
});

describe("Mi cuenta — validación y errores", () => {
  const ok = { current: "vieja-123", next: "nueva-1234", confirm: "nueva-1234" };

  it("formulario correcto → null", () => {
    expect(validatePasswordChange(ok)).toBeNull();
  });

  it("pide la contraseña actual", () => {
    expect(validatePasswordChange({ ...ok, current: "" })).toMatch(/actual/);
  });

  it("nueva demasiado corta", () => {
    expect(
      validatePasswordChange({ ...ok, next: "corta", confirm: "corta" })
    ).toMatch(/8 caracteres/);
  });

  it("confirmación distinta", () => {
    expect(validatePasswordChange({ ...ok, confirm: "otra-cosa-1" })).toMatch(
      /no coincide/
    );
  });

  it("nueva igual a la actual", () => {
    expect(
      validatePasswordChange({ current: "misma-123", next: "misma-123", confirm: "misma-123" })
    ).toMatch(/distinta/);
  });

  it("traduce los códigos de Better Auth", () => {
    expect(passwordChangeError({ code: "INVALID_PASSWORD", status: 400 })).toBe(
      "La contraseña actual no es correcta."
    );
    expect(passwordChangeError({ status: 429 })).toMatch(/Demasiados intentos/);
    expect(passwordChangeError({ code: "RARO", status: 500 })).toMatch(
      /No se pudo cambiar/
    );
    expect(passwordChangeError(null)).toMatch(/No se pudo cambiar/);
  });
});
