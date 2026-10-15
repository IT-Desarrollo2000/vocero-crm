import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { assertCatalogKey, type CatalogStorage, StorageError } from "./types";

/**
 * 019 — Almacenamiento local del catálogo (default): `MEDIA_DIR/{org}/catalog/{fileId}`.
 *
 * Comparte el volumen con la caché de adjuntos de 018, pero la purga de 30
 * días NO lo toca: purge.ts solo borra rutas de filas de `media_asset`.
 * Escritura atómica (tmp + rename): un lector nunca ve un archivo a medias y
 * un reemplazo no deja el anterior truncado.
 *
 * `rootDir` existe para las pruebas (directorio temporal); en la app es
 * `MEDIA_DIR`.
 */
export function createLocalCatalogStorage(rootDir?: string): CatalogStorage {
  const root = () => path.resolve(rootDir ?? getEnv().MEDIA_DIR);

  function fileFor(key: string): string {
    assertCatalogKey(key);
    const base = root();
    const file = path.resolve(base, ...key.split("/"));
    // Defensa en profundidad: la clave ya es segura, pero la ruta resuelta
    // tiene que quedar DENTRO del volumen.
    if (!file.startsWith(base + path.sep)) {
      throw new StorageError("misconfigured", "Clave de almacenamiento inválida");
    }
    return file;
  }

  function unavailable(action: string): StorageError {
    // Sin la ruta ni el mensaje del sistema: puede llegar a la UI.
    return new StorageError("unavailable", `No se pudo ${action} el archivo en el disco local`);
  }

  return {
    provider: "local",

    async put(key, data) {
      const file = fileFor(key);
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(tmp, data);
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        console.error("[catalog/local] put falló", (err as NodeJS.ErrnoException).code);
        throw unavailable("guardar");
      }
    },

    async get(key) {
      const file = fileFor(key);
      try {
        return await readFile(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new StorageError("not_found", "El archivo no existe en el almacenamiento");
        }
        console.error("[catalog/local] get falló", (err as NodeJS.ErrnoException).code);
        throw unavailable("leer");
      }
    },

    async delete(key) {
      const file = fileFor(key);
      try {
        await rm(file, { force: true });
      } catch (err) {
        console.error("[catalog/local] delete falló", (err as NodeJS.ErrnoException).code);
        throw unavailable("borrar");
      }
    },

    async test() {
      const base = root();
      const probe = path.join(base, `.catalog-probe-${randomBytes(6).toString("hex")}`);
      try {
        await mkdir(base, { recursive: true });
        await writeFile(probe, "ok");
        await rm(probe, { force: true });
      } catch (err) {
        console.error("[catalog/local] test falló", (err as NodeJS.ErrnoException).code);
        throw new StorageError("unavailable", "El disco local no acepta escrituras");
      }
    },
  };
}
