import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// La versión sale de package.json y no de una constante aparte: duplicarla es
// tenerla desactualizada en uno de los dos lados, y justo esta no puede mentir.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

const nextConfig: NextConfig = {
  // standalone es para la imagen Docker (Linux). En Windows el trazado crea
  // symlinks que requieren permisos elevados, así que ahí se omite.
  output: process.platform === "win32" ? undefined : "standalone",
  // El paquete `postgres` usa APIs de Node que no deben empaquetarse en el bundle.
  // 036: `exceljs` (importar contactos desde Excel) tampoco: es grande, usa
  // streams de Node y solo lo cargan las rutas de /api/contacts/import.
  serverExternalPackages: ["postgres", "exceljs"],
  // 036: en Node 22 algunas dependencias de exceljs (vía `is-generator-function`
  // e `is-async-function`) se cargan por la condición `module-sync` →
  // `require.mjs`, que el trazado de Next no sigue: sin esto la imagen no trae
  // esos archivos e `import("exceljs")` falla con «Cannot find module».
  outputFileTracingIncludes: {
    "/api/contacts/import/**": [
      "./node_modules/.pnpm/generator-function@*/node_modules/generator-function/*.mjs",
      "./node_modules/.pnpm/async-function@*/node_modules/async-function/*.mjs",
    ],
  },
  // Se congelan al construir: el binario lleva dentro de qué código salió, así
  // que no puede mentir en tiempo de ejecución. `SOURCE_COMMIT` lo inyecta
  // Coolify solo; con docker compose se pasa por `--build-arg` y si falta, la
  // app enseña solo la versión.
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_COMMIT: process.env.SOURCE_COMMIT ?? "",
  },
};

export default nextConfig;
