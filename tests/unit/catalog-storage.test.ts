import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCatalogStorage } from "@/server/catalog/storage";
import { createLocalCatalogStorage } from "@/server/catalog/storage/local";
import { catalogStorageKey, StorageError } from "@/server/catalog/storage/types";
import { runStorageContract } from "./helpers/catalog-storage-contract";

/**
 * 019 — Almacenamiento del catálogo: el contrato común contra `local` en un
 * directorio temporal + lo propio del disco (ruta, atomicidad).
 */

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vocero-catalog-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

runStorageContract("local", () => createLocalCatalogStorage(root));

describe("catalogStorageKey", () => {
  it("{org}/catalog/{fileId}", () => {
    expect(catalogStorageKey("org_1", "pf_abc")).toBe("org_1/catalog/pf_abc");
  });

  it("rechaza segmentos inseguros", () => {
    for (const [o, f] of [
      ["..", "pf_1"],
      ["org_1", ".."],
      ["org/1", "pf_1"],
      ["org_1", "pf 1"],
      ["", "pf_1"],
    ] as const) {
      expect(() => catalogStorageKey(o, f)).toThrow(StorageError);
    }
  });
});

describe("storage local", () => {
  it("guarda en MEDIA_DIR/{org}/catalog/{fileId} sin dejar temporales", async () => {
    const s = createLocalCatalogStorage(root);
    const key = catalogStorageKey("org_disk", "pf_disk");
    await s.put(key, Buffer.from("hola"), "text/plain");
    const dir = path.join(root, "org_disk", "catalog");
    expect(await readdir(dir)).toEqual(["pf_disk"]);
    await s.delete(key);
    expect(await readdir(dir)).toEqual([]);
  });

  it("getCatalogStorage: local por defecto; azure-blob aún no → misconfigured", () => {
    expect(getCatalogStorage().provider).toBe("local");
    expect(getCatalogStorage("local").provider).toBe("local");
    expect(() => getCatalogStorage("azure-blob")).toThrow(StorageError);
  });
});
