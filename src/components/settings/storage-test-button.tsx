"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * 019 — "Probar conexión" del almacenamiento del catálogo. Es lo único de
 * cliente en Ajustes → Almacenamiento: el estado (proveedor, cuenta,
 * contenedor) lo pinta el servidor, así que el nombre del proveedor nunca
 * viaja en un bundle de cliente de una instancia que no lo usa.
 */
export function StorageTestButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  async function probar() {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/settings/catalog-storage/test", { method: "POST" }).catch(
      () => null
    );
    setBusy(false);
    if (res?.ok) {
      setMessage({ kind: "ok", text: "Conexión correcta" });
      return;
    }
    const body = (await res?.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    setMessage({
      kind: "error",
      text: body?.error?.message ?? "No se pudo probar la conexión",
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" onClick={probar} disabled={busy}>
        {busy ? "Probando…" : "Probar conexión"}
      </Button>
      {message && (
        <span
          role="status"
          className={
            message.kind === "ok" ? "text-sm text-brand-text" : "text-sm text-destructive"
          }
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
