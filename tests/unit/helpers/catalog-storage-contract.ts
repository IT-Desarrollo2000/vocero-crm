import { describe, expect, it } from "vitest";
import {
  type CatalogStorage,
  catalogStorageKey,
  StorageError,
  trainingStorageKey,
} from "@/server/catalog/storage/types";

/**
 * 019 — Suite de contrato de `CatalogStorage` (FR-910). La corre cada
 * implementación: `local` contra un directorio temporal y, en fase C,
 * `azure-blob` contra Azurite. `factory` se llama una vez por prueba.
 */
export function runStorageContract(
  name: string,
  factory: () => CatalogStorage | Promise<CatalogStorage>
): void {
  const org = "org_contract";
  let n = 0;
  const key = () => catalogStorageKey(org, `pf_contract${Date.now()}${n++}`);

  async function expectStorageError(p: Promise<unknown>, code: StorageError["code"]) {
    const err = await p.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe(code);
  }

  describe(`CatalogStorage (${name}): contrato`, () => {
    it("put → get devuelve los mismos bytes", async () => {
      const s = await factory();
      const k = key();
      const data = Buffer.from([0, 1, 2, 250, 255]);
      await s.put(k, data, "application/octet-stream");
      expect(Buffer.compare(await s.get(k), data)).toBe(0);
      await s.delete(k);
    });

    it("put sobre una clave existente la reemplaza", async () => {
      const s = await factory();
      const k = key();
      await s.put(k, Buffer.from("uno"), "text/plain");
      await s.put(k, Buffer.from("dos"), "text/plain");
      expect((await s.get(k)).toString()).toBe("dos");
      await s.delete(k);
    });

    it("get de algo que no existe → not_found", async () => {
      const s = await factory();
      await expectStorageError(s.get(key()), "not_found");
    });

    it("delete borra y es idempotente", async () => {
      const s = await factory();
      const k = key();
      await s.put(k, Buffer.from("x"), "text/plain");
      await s.delete(k);
      await expectStorageError(s.get(k), "not_found");
      await expect(s.delete(k)).resolves.toBeUndefined();
    });

    it("rechaza claves inseguras o fuera de forma sin tocar nada", async () => {
      const s = await factory();
      const bad = [
        "../etc/passwd",
        `${org}/catalog/../x`,
        `${org}/catalog/..`,
        `../catalog/pf_1`,
        `${org}/otro/pf_1`,
        `${org}/catalog/a/b`,
        `${org}/catalog/`,
        "/abs/catalog/pf_1",
        `${org}\\catalog\\pf_1`,
      ];
      for (const k of bad) {
        await expectStorageError(s.put(k, Buffer.from("x"), "text/plain"), "misconfigured");
        await expectStorageError(s.get(k), "misconfigured");
        await expectStorageError(s.delete(k), "misconfigured");
        await expectStorageError(s.stat(k), "misconfigured");
        await expectStorageError(s.getRange(k, 0, 0), "misconfigured");
      }
    });

    // ── 034: espacio `capacitacion`, stat y getRange ────────────────────
    it("una clave de `capacitacion` guarda y lee igual que una de `catalog`", async () => {
      const s = await factory();
      const k = trainingStorageKey(org, `tra_contract${Date.now()}${n++}`);
      await s.put(k, Buffer.from("material"), "application/pdf");
      expect((await s.get(k)).toString()).toBe("material");
      await s.delete(k);
      await expectStorageError(s.get(k), "not_found");
    });

    it("rechaza espacios que no existen y claves de capacitación inseguras", async () => {
      const s = await factory();
      for (const k of [`${org}/capacitacion/..`, `${org}/capacitacion/a/b`, `${org}/training/tra_1`, `../capacitacion/tra_1`]) {
        await expectStorageError(s.put(k, Buffer.from("x"), "text/plain"), "misconfigured");
        await expectStorageError(s.stat(k), "misconfigured");
      }
    });

    it("stat devuelve el tamaño en bytes", async () => {
      const s = await factory();
      const k = key();
      await s.put(k, Buffer.alloc(1234, 7), "application/octet-stream");
      expect(await s.stat(k)).toEqual({ size: 1234 });
      await s.delete(k);
    });

    it("stat de algo que no existe → not_found", async () => {
      const s = await factory();
      await expectStorageError(s.stat(key()), "not_found");
    });

    it("getRange devuelve start..end inclusive", async () => {
      const s = await factory();
      const k = key();
      const data = Buffer.from("0123456789abcdef");
      await s.put(k, data, "application/octet-stream");
      expect((await s.getRange(k, 1, 3)).toString()).toBe("123");
      expect((await s.getRange(k, 0, 0)).toString()).toBe("0");
      expect((await s.getRange(k, 10, 15)).toString()).toBe("abcdef");
      expect(Buffer.compare(await s.getRange(k, 0, data.length - 1), data)).toBe(0);
      await s.delete(k);
    });

    it("getRange de un archivo grande no se corta (lecturas parciales)", async () => {
      const s = await factory();
      const k = key();
      const data = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      await s.put(k, data, "video/mp4");
      const start = 1_000_003;
      const end = 2_500_000;
      const got = await s.getRange(k, start, end);
      expect(got.length).toBe(end - start + 1);
      expect(Buffer.compare(got, data.subarray(start, end + 1))).toBe(0);
      await s.delete(k);
    });

    it("getRange de algo que no existe → not_found", async () => {
      const s = await factory();
      await expectStorageError(s.getRange(key(), 0, 9), "not_found");
    });

    it("test() resuelve con el proveedor sano", async () => {
      const s = await factory();
      await expect(s.test()).resolves.toBeUndefined();
    });
  });
}
