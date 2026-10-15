import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";
import { CatalogClient } from "@/components/catalog/catalog-client";

export const dynamic = "force-dynamic";

/**
 * 019 — Catálogo de productos. Lo ve todo el equipo (FR-906); los botones de
 * edición solo los ve el Propietario. Es solo UI: la API responde 403 a
 * cualquier escritura de otro rol.
 */
export default async function CatalogPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  return <CatalogClient canEdit={isOwner(session)} />;
}
