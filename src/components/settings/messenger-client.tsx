"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChannelWebhookCard,
  ConnectedBanner,
  DisconnectCard,
  HumanAgentNote,
  ReconnectBanner,
  type ChannelWebhookInfo,
} from "@/components/settings/instagram-client";

/**
 * 017 — Ajustes → Messenger: conectar la Página de Facebook, ver su estado y
 * los datos del webhook para pegar en la app de Meta.
 */

type Connection = {
  pageId: string;
  pageName: string | null;
  status: "connected" | "reconnect_required";
  tokenLast4: string;
};

export function MessengerSettingsClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [webhook, setWebhook] = useState<ChannelWebhookInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/settings/messenger").catch(() => null);
    if (res?.ok) {
      const data = (await res.json().catch(() => null)) as {
        connection: Connection | null;
        webhook: ChannelWebhookInfo;
      } | null;
      if (data) {
        setConnection(data.connection);
        setWebhook(data.webhook);
      }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function disconnect() {
    const res = await fetch("/api/settings/messenger", {
      method: "DELETE",
    }).catch(() => null);
    if (!res?.ok) return "No se pudo desconectar la Página";
    await refetch();
    return null;
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      {connection?.status === "reconnect_required" && (
        <ReconnectBanner
          title="El token de la Página expiró o fue revocado."
          body="Los envíos están pausados. Pega un token nuevo abajo y guarda para reconectar."
        />
      )}

      {connection && connection.status === "connected" && (
        <ConnectedBanner
          title={`Página conectada: ${connection.pageName ?? connection.pageId}`}
          detail={`ID ${connection.pageId} · token ••••${connection.tokenLast4}`}
        />
      )}

      <ConnectForm
        existing={connection}
        onSaved={() => void refetch()}
      />

      {connection && (
        <DisconnectCard
          what="la Página de Facebook"
          onDisconnect={disconnect}
        />
      )}

      {webhook && (
        <ChannelWebhookCard
          webhook={webhook}
          description={
            <>
              En tu app de Meta → Messenger → Webhooks, pega estos valores y
              suscribe el campo <span className="text-foreground">messages</span>.
              Al guardar la conexión, el CRM suscribe la Página a tu app.
            </>
          }
          secretEnv="FB_APP_SECRET o META_APP_SECRET"
        />
      )}

      <HumanAgentNote />
    </div>
  );
}

function ConnectForm({
  existing,
  onSaved,
}: {
  existing: Connection | null;
  onSaved: () => void;
}) {
  const [pageId, setPageId] = useState(existing?.pageId ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const pageIdValid = /^\d+$/.test(pageId.trim());
  const canSave = pageIdValid && token.trim();

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(null);
    setWarning(null);
    const res = await fetch("/api/settings/messenger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: pageId.trim(), token: token.trim() }),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      setError("Sin conexión con el servidor");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      pageName?: string | null;
      subscribed?: boolean;
      warning?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      setError(data?.error?.message ?? "No se pudo guardar la conexión");
      return;
    }
    setToken("");
    setSaved(
      data?.pageName
        ? `Página "${data.pageName}" conectada.`
        : "Conexión guardada."
    );
    if (data?.warning) setWarning(data.warning);
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {existing
            ? "Reconectar / actualizar la Página"
            : "Conectar tu Página de Facebook"}
        </CardTitle>
        <CardDescription>
          El token se valida contra Meta ANTES de guardarse y se almacena
          cifrado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-background/40 p-4 text-sm text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">
            ¿De dónde sale el token?
          </p>
          Es el token de la <span className="text-foreground">Página</span>, no
          el de tu usuario. Lo ideal es generarlo con un{" "}
          <span className="text-foreground">usuario del sistema</span> en
          Business Manager (no expira), con los permisos{" "}
          <span className="text-foreground">pages_messaging</span>,{" "}
          <span className="text-foreground">pages_manage_metadata</span> y{" "}
          <span className="text-foreground">pages_show_list</span>.
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fb-page-id">ID de la Página</Label>
          <Input
            id="fb-page-id"
            inputMode="numeric"
            placeholder="102030405060708"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            autoComplete="off"
          />
          {pageId.trim() && !pageIdValid ? (
            <p className="text-xs text-danger-text">
              El ID de la Página son solo dígitos.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Tu Página → Información → Transparencia de la página, o en
              Business Manager → Cuentas → Páginas.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fb-token">Token de acceso de la Página</Label>
          <Input
            id="fb-token"
            type="password"
            placeholder={
              existing
                ? `Guardado (••••${existing.tokenLast4}) — pégalo de nuevo para guardar cambios`
                : "EAAG…"
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>

        {error && (
          <p className="text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}
        {saved && <p className="text-sm text-success-text">{saved}</p>}
        {warning && (
          <p className="flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-3 text-xs text-warning-text">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {warning}
          </p>
        )}

        <Button disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? "Validando…" : "Guardar conexión"}
        </Button>
      </CardContent>
    </Card>
  );
}
