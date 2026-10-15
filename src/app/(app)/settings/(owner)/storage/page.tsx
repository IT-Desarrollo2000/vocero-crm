import { notFound } from "next/navigation";
import { StorageTestButton } from "@/components/settings/storage-test-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  azureCatalogStorageEnabled,
  describeAzureCatalogStorage,
} from "@/server/catalog/storage";

export const dynamic = "force-dynamic";

/**
 * 019 — Ajustes → Almacenamiento (FR-913, ADR-003). Solo lectura: el
 * conector se configura con variables de despliegue, no aquí. Sin
 * `CATALOG_STORAGE=azure-blob` esta pantalla no existe en la instancia.
 *
 * Componente de servidor a propósito: la cuenta y el contenedor se pintan
 * aquí y la clave nunca sale del proceso.
 */
export default function StorageSettingsPage() {
  if (!azureCatalogStorageEnabled()) notFound();
  const view = describeAzureCatalogStorage();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Almacenamiento del catálogo</CardTitle>
        <CardDescription>
          Las fotos y fichas nuevas del Catálogo se guardan aquí. Se configura con
          las variables de despliegue; lo ya subido sigue donde se guardó.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm" data-testid="catalog-storage-status">
          Almacenamiento del catálogo: Azure Blob · cuenta{" "}
          <span className="font-medium">{view.accountName ?? "—"}</span> · contenedor{" "}
          <span className="font-medium">{view.container ?? "—"}</span>
        </p>
        {view.error && (
          <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {view.error}. Mientras no se corrija, subir y abrir archivos del
            catálogo guardados ahí responde con error; el resto del CRM sigue
            funcionando.
          </p>
        )}
        <StorageTestButton />
      </CardContent>
    </Card>
  );
}
