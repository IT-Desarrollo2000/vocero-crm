import { SeguimientoClient } from "@/components/pipeline/seguimiento-client";

export const dynamic = "force-dynamic";

/** 035: `?vista=pendientes` abre Pendientes; cualquier otra cosa, el Tablero. */
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { vista } = await searchParams;
  return <SeguimientoClient view={vista === "pendientes" ? "pendientes" : "tablero"} />;
}
