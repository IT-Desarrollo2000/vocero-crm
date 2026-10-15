import { describe, expect, it } from "vitest";
import {
  type CatalogStorage,
  catalogStorageKey,
  StorageError,
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
      }
    });

    it("test() resuelve con el proveedor sano", async () => {
      const s = await factory();
      await expect(s.test()).resolves.toBeUndefined();
    });
  });
}
