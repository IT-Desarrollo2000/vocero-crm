import { describe, expect, it } from "vitest";
import { loginPathFor, safeNextPath } from "@/lib/safe-next";

/**
 * 031 — `?next=` del login. Lo que importa es que NUNCA salga de la app: el
 * parámetro lo escribe cualquiera y el login no puede ser una redirección
 * abierta.
 */

describe("safeNextPath", () => {
  it("acepta rutas internas y las devuelve tal cual", () => {
    expect(safeNextPath("/ayuda")).toBe("/ayuda");
    expect(safeNextPath("/inbox?contact=ct_1")).toBe("/inbox?contact=ct_1");
    expect(safeNextPath("/ayuda#plantillas")).toBe("/ayuda#plantillas");
  });

  it("sin valor, a la Bandeja", () => {
    expect(safeNextPath(null)).toBe("/inbox");
    expect(safeNextPath(undefined)).toBe("/inbox");
    expect(safeNextPath("")).toBe("/inbox");
  });

  it("rechaza destinos externos y sus disfraces", () => {
    expect(safeNextPath("//evil.com")).toBe("/inbox");
    expect(safeNextPath("https://evil.com")).toBe("/inbox");
    expect(safeNextPath("/\\evil.com")).toBe("/inbox");
    expect(safeNextPath("/%2F%2Fevil.com")).toBe("/inbox");
    expect(safeNextPath("/%5Cevil.com")).toBe("/inbox");
    expect(safeNextPath("%2F%2Fevil.com")).toBe("/inbox");
    expect(safeNextPath("javascript:alert(1)")).toBe("/inbox");
  });

  it("rechaza espacios, caracteres de control y codificaciones rotas", () => {
    expect(safeNextPath(" /ayuda")).toBe("/inbox");
    expect(safeNextPath("/\tevil.com")).toBe("/inbox");
    expect(safeNextPath("/%09/evil.com")).toBe("/inbox");
    expect(safeNextPath("/ayuda%")).toBe("/inbox");
  });

  it("no vuelve al login ni a la API", () => {
    expect(safeNextPath("/login")).toBe("/inbox");
    expect(safeNextPath("/login?next=/ayuda")).toBe("/inbox");
    expect(safeNextPath("/api/x")).toBe("/inbox");
    expect(safeNextPath("/API/x")).toBe("/inbox");
  });

  it("rechaza lo exageradamente largo", () => {
    expect(safeNextPath(`/${"a".repeat(3000)}`)).toBe("/inbox");
  });
});

describe("loginPathFor", () => {
  it("lleva el destino codificado", () => {
    expect(loginPathFor("/ayuda")).toBe("/login?next=%2Fayuda");
    expect(loginPathFor("/inbox?contact=ct_1")).toBe(
      "/login?next=%2Finbox%3Fcontact%3Dct_1"
    );
  });

  it("a la Bandeja o con destino inválido, login a secas", () => {
    expect(loginPathFor("/inbox")).toBe("/login");
    expect(loginPathFor(null)).toBe("/login");
    expect(loginPathFor("//evil.com")).toBe("/login");
  });
});
