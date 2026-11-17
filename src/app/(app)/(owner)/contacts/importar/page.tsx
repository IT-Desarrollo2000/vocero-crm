import { ImportClient } from "@/components/contacts/import/import-client";

export const dynamic = "force-dynamic";

/**
 * 036 fase 2 — /contacts/importar: importar contactos desde Excel. Solo el
 * Propietario: el layout de `(owner)` responde 404 al Vendedor (y las rutas
 * de /api/contacts/import, 403). El grupo no cambia la URL.
 */
export default function ImportarContactosPage() {
  return <ImportClient />;
}
