"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * 011 — Ajustes → Leads externos: la clave con la que el ERP del negocio
 * entrega los leads del formulario web y de FastApp, y si están llegando.
 */

type Intake = {
  keyLast4: string;
  lastReceivedAt: { website?: string; fast_app?: string };
  createdAt: string;
  updatedAt: string;
};

const ORIGINS: { key: keyof Intake["lastReceivedAt"]; label: string }[] = [
  { key: "website", label: "Formulario del sitio web" },
  { key: "fast_app", label: "FastApp (promotores)" },
];

function formatWhen(iso: string | undefined): string {
  if (!iso) return "Aún no llega ninguno";
  return new Date(iso).toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** SQL para guardar URL y clave en el Vault del ERP (Supabase). */
function vaultSql(endpoint: string, key: string): string {
  const q = (s: string) => s.replace(/'/g, "''");
  return [
    `select vault.create_secret('${q(endpoint)}', 'crm_intake_url');`,
    `select vault.create_secret('${q(key)}', 'crm_intake_key');`,
    "-- Si ya existían (rotación):",
    `-- select vault.update_secret((select id from vault.secrets where name = 'crm_intake_key'), '${q(key)}');`,
  ].join("\n");
}

export function IntakeClient() {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [loaded, setLoaded] = useState(false);
  /** La clave completa: solo existe en memoria justo después de generarla. */
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  async function load() {
    const res = await fetch("/api/settings/intake").catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { intake: Intake | null; endpoint: string };
      setIntake(data.intake);
      setEndpoint(data.endpoint);
    }
    setLoaded(true);
  }

  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/intake", { method: "PUT" }).catch(
      () => null
    );
    setBusy(false);
    if (!res?.ok) {
      setError("No se pudo generar la clave");
      return;
    }
    const data = (await res.json()) as { key: string; intake: Intake | null };
    setFreshKey(data.key);
    setIntake(data.intake);
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/intake", { method: "DELETE" }).catch(
      () => null
    );
    setBusy(false);
    setConfirmRevoke(false);
    if (!res?.ok) {
      setError("No se pudo revocar la clave");
      return;
    }
    setFreshKey(null);
    setIntake(null);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Leads externos</CardTitle>
          <CardDescription>
            Cada lead nuevo del formulario de tu sitio web o de FastApp entra a
            la Bandeja como una conversación sin asignar, con una tarjeta de lo
            que pidió. Contéstale con una plantilla: la ventana de 24 horas de
            WhatsApp sigue cerrada hasta que te escriba.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Dirección de entrada</p>
            <code
              className="block break-all rounded-md border bg-muted px-2 py-1.5 text-xs"
              data-testid="intake-endpoint"
            >
              {endpoint || "…"}
            </code>
          </div>

          {!loaded ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : intake ? (
            <p className="text-sm text-muted-foreground" data-testid="intake-key-status">
              Clave activa ····{intake.keyLast4} · actualizada{" "}
              {formatWhen(intake.updatedAt)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="intake-key-status">
              Sin clave: el ERP no puede entregar leads hasta que generes una.
            </p>
          )}

          {freshKey ? (
            <div
              className="space-y-2 rounded-md border border-warning-soft bg-warning-tint p-3"
              role="status"
            >
              <p className="text-sm font-semibold">
                Copia la clave ahora: no se volverá a mostrar.
              </p>
              <code
                className="block select-all break-all rounded bg-background px-2 py-1.5 text-xs"
                data-testid="intake-fresh-key"
              >
                {freshKey}
              </code>
              <p className="text-xs text-muted-foreground">
                Guárdala en el Vault del ERP (SQL editor de Supabase):
              </p>
              <pre className="overflow-x-auto whitespace-pre rounded bg-background px-2 py-1.5 text-[11px]">
                {vaultSql(endpoint, freshKey)}
              </pre>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void generate()} disabled={busy || !loaded}>
              {intake ? "Rotar clave" : "Generar clave"}
            </Button>
            {intake && !confirmRevoke ? (
              <Button
                variant="outline"
                onClick={() => setConfirmRevoke(true)}
                disabled={busy}
              >
                Revocar
              </Button>
            ) : null}
            {intake && confirmRevoke ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => void revoke()}
                  disabled={busy}
                >
                  Sí, revocar: dejarán de entrar leads
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmRevoke(false)}
                  disabled={busy}
                >
                  Cancelar
                </Button>
              </>
            ) : null}
          </div>
          {intake ? (
            <p className="text-xs text-muted-foreground">
              Al rotar, la clave anterior deja de valer en ese instante: el ERP
              recibirá 401 hasta que actualices el secreto en su Vault.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Último lead recibido</CardTitle>
          <CardDescription>
            Si un origen deja de actualizarse, revisa la clave y el reenvío del
            ERP.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-sm">
            {ORIGINS.map((o) => (
              <li key={o.key} className="flex justify-between gap-3">
                <span>{o.label}</span>
                <span className="text-muted-foreground" data-testid={`intake-last-${o.key}`}>
                  {formatWhen(intake?.lastReceivedAt[o.key])}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
