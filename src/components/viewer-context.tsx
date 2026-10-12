"use client";

import { createContext, useContext } from "react";
import type { Role } from "@/lib/roles";

/**
 * Quién está mirando la app (dev-tasks/00, T-00-14). Lo resuelve el servidor
 * en `(app)/layout.tsx` y baja por `AppShell`; los componentes de cliente lo
 * leen para ocultar lo que no es de su rol. Es solo UI: la autorización real
 * vive en la API y en las guardas de página.
 */
export type Viewer = { userId: string; role: Role };

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer {
  const viewer = useContext(ViewerContext);
  if (!viewer) {
    throw new Error("useViewer() debe usarse dentro de <ViewerProvider>");
  }
  return viewer;
}
