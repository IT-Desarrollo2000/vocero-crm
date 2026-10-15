import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  azureCatalogStorageEnabled,
  currentCatalogStorageProvider,
  describeAzureCatalogStorage,
  getCatalogStorage,
  parseCatalogStorageProvider,
} from "@/server/catalog/storage";
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

});

describe("selección de proveedor (CATALOG_STORAGE)", () => {
  const KEY =
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
  const VARS = ["CATALOG_STORAGE", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  it("parseCatalogStorageProvider: solo `azure-blob` lo enciende; lo demás es local", () => {
    expect(parseCatalogStorageProvider(undefined)).toBe("local");
    expect(parseCatalogStorageProvider("")).toBe("local");
    expect(parseCatalogStorageProvider("local")).toBe("local");
    expect(parseCatalogStorageProvider(" Azure-Blob ")).toBe("azure-blob");
    for (const raw of ["azure", "s3", "on", "azureblob", "azure_blob"]) {
      expect(parseCatalogStorageProvider(raw)).toBe("local");
    }
  });

  it("sin variable: local para lo nuevo y conector apagado", () => {
    expect(currentCatalogStorageProvider()).toBe("local");
    expect(azureCatalogStorageEnabled()).toBe(false);
    expect(getCatalogStorage().provider).toBe("local");
    expect(getCatalogStorage("local").provider).toBe("local");
  });

  it("con azure-blob: lo nuevo va a Azure y lo guardado en local se sigue leyendo de local", () => {
    process.env.CATALOG_STORAGE = "azure-blob";
    process.env.AZURE_STORAGE_CONNECTION_STRING = `AccountName=voceroprod;AccountKey=${KEY}`;
    process.env.AZURE_STORAGE_CONTAINER = "catalogo";
    expect(azureCatalogStorageEnabled()).toBe(true);
    expect(getCatalogStorage().provider).toBe("azure-blob");
    expect(getCatalogStorage("local").provider).toBe("local");
    // Memoizado mientras la config no cambie.
    expect(getCatalogStorage()).toBe(getCatalogStorage("azure-blob"));
  });

  it("un archivo guardado en Azure se pide a Azure aunque el proveedor actual sea local", () => {
    expect(getCatalogStorage("azure-blob").provider).toBe("azure-blob");
  });

  it("azure-blob con config inválida: no lanza, registra UNA línea saneada y opera con misconfigured", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    process.env.CATALOG_STORAGE = "azure-blob";
    process.env.AZURE_STORAGE_CONNECTION_STRING = "AccountName=x1y2z3;AccountKey=SECRETO";
    const s = getCatalogStorage();
    getCatalogStorage();
    expect(s.provider).toBe("azure-blob");
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("SECRETO");
    const err = await s
      .get(catalogStorageKey("org_1", "pf_1"))
      .then(() => null, (e: unknown) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err?.code).toBe("misconfigured");
  });

  it("describeAzureCatalogStorage: cuenta y contenedor, nunca la clave ni la cadena", () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=voceroprod;AccountKey=${KEY};EndpointSuffix=core.windows.net`;
    process.env.AZURE_STORAGE_CONTAINER = "catalogo";
    const view = describeAzureCatalogStorage();
    expect(view).toEqual({
      provider: "azure-blob",
      accountName: "voceroprod",
      container: "catalogo",
      error: null,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
    delete process.env.AZURE_STORAGE_CONTAINER;
    expect(describeAzureCatalogStorage().error).toMatch(/AZURE_STORAGE_CONTAINER/);
  });
});
