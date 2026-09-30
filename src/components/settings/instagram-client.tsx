"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

/**
 * 017 — Ajustes → Instagram: conectar la cuenta (Meta directo o Zernio), ver
 * su estado y los datos del webhook para pegar en la app de Meta.
 */

type Source = "meta" | "zernio";

type Connection = {
  source: Source;
  igUserId: string;
  accountRef: string | null;
  username: string | null;
  status: "connected" | "reconnect_required";
  tokenLast4: string;
};

export type ChannelWebhookInfo = {
  url: string;
  verifyToken: string;
  isHttps: boolean;
  signatureLayer: boolean;
};

export function InstagramSettingsClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [webhook, setWebhook] = useState<ChannelWebhookInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/settings/instagram").catch(() => null);
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
    const res = await fetch("/api/settings/instagram", {
      method: "DELETE",
    }).catch(() => null);
    if (!res?.ok) return "No se pudo desconectar la cuenta";
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
          title="El token de Instagram expiró o fue revocado."
          body="Los envíos están pausados. Pega un token nuevo abajo y guarda para reconectar."
        />
      )}

      {connection && connection.status === "connected" && (
        <ConnectedBanner
          title={`Cuenta conectada: ${
            connection.username
              ? `@${connection.username}`
              : connection.igUserId
          }`}
          detail={`${
            connection.source === "zernio" ? "Vía Zernio" : "Meta directo"
          } · token ••••${connection.tokenLast4}`}
        />
      )}

      <ConnectForm
        existing={connection}
        onSaved={() => void refetch()}
      />

      {connection && (
        <DisconnectCard
          what="la cuenta de Instagram"
          onDisconnect={disconnect}
        />
      )}

      {webhook && (
        <ChannelWebhookCard
          webhook={webhook}
          description={
            <>
              Solo para el modo Meta directo: en tu app de Meta → Instagram →
              Webhooks, pega estos valores y suscribe el campo{" "}
              <span className="text-foreground">messages</span>. En modo Zernio
              el webhook se configura en Zernio.
            </>
          }
          secretEnv="IG_APP_SECRET o META_APP_SECRET"
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
  const [source, setSource] = useState<Source>(existing?.source ?? "meta");
  const [igUserId, setIgUserId] = useState(existing?.igUserId ?? "");
  const [accountRef, setAccountRef] = useState(existing?.accountRef ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [token, setToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const canSave =
    igUserId.trim() &&
    token.trim() &&
    (source === "meta" || accountRef.trim());

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(null);
    const res = await fetch("/api/settings/instagram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        igUserId: igUserId.trim(),
        token: token.trim(),
        ...(source === "zernio"
          ? {
              accountRef: accountRef.trim(),
              ...(username.trim()
                ? { username: username.trim().replace(/^@/, "") }
                : {}),
              ...(webhookSecret.trim()
                ? { webhookSecret: webhookSecret.trim() }
                : {}),
            }
          : {}),
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      setError("Sin conexión con el servidor");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      username?: string | null;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      setError(data?.error?.message ?? "No se pudo guardar la conexión");
      return;
    }
    setToken("");
    setWebhookSecret("");
    setSaved(
      data?.username ? `Conectado como @${data.username}.` : "Conexión guardada."
    );
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {existing
            ? "Reconectar / actualizar Instagram"
            : "Conectar tu cuenta de Instagram"}
        </CardTitle>
        <CardDescription>
          El token se valida contra la plataforma ANTES de guardarse y se
          almacena cifrado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ig-source">¿Cómo se conecta?</Label>
          <select
            id="ig-source"
            value={source}
            onChange={(e) => setSource(e.target.value as Source)}
            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="meta">Meta directo (API de Instagram)</option>
            <option value="zernio">Zernio</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {source === "meta"
              ? "Tu propia app en developers.facebook.com con Instagram API (inicio de sesión con Instagram) y el permiso instagram_business_manage_messages."
              : "La cuenta ya está conectada en Zernio: pega su API key y el accountId de la cuenta."}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ig-user-id">ID de usuario de Instagram (IG_ID)</Label>
            <Input
              id="ig-user-id"
              placeholder="17841400000000000"
              value={igUserId}
              onChange={(e) => setIgUserId(e.target.value)}
              autoComplete="off"
            />
          </div>
          {source === "zernio" && (
            <div className="space-y-1.5">
              <Label htmlFor="ig-account-ref">accountId de Zernio</Label>
              <Input
                id="ig-account-ref"
                placeholder="ID de la cuenta en Zernio"
                value={accountRef}
                onChange={(e) => setAccountRef(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
        </div>

        {source === "zernio" && (
          <div className="space-y-1.5">
            <Label htmlFor="ig-username">Usuario (opcional)</Label>
            <Input
              id="ig-username"
              placeholder="@tu_negocio"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="ig-token">
            {source === "meta" ? "Token de acceso" : "API key de Zernio"}
          </Label>
          <Input
            id="ig-token"
            type="password"
            placeholder={
              existing
                ? `Guardado (••••${existing.tokenLast4}) — pégalo de nuevo para guardar cambios`
                : source === "meta"
                  ? "IGAA…"
                  : "API key"
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>

        {source === "zernio" && (
          <div className="space-y-1.5">
            <Label htmlFor="ig-webhook-secret">
              Secreto del webhook de Zernio (opcional)
            </Label>
            <Input
              id="ig-webhook-secret"
              type="password"
              placeholder="Para validar la firma de los eventos de Zernio"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}
        {saved && <p className="text-sm text-success-text">{saved}</p>}

        <Button disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? "Validando…" : "Guardar conexión"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ReconnectBanner({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium text-danger-text">{title}</p>
        <p className="text-danger-text opacity-80">{body}</p>
      </div>
    </div>
  );
}

export function ConnectedBanner({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-success-soft bg-success-tint p-4">
      <CheckCircle2 className="h-5 w-5 text-success" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate font-medium text-success-text">{title}</p>
        <p className="text-success-text opacity-80">{detail}</p>
      </div>
      <Badge variant="success">Conectado</Badge>
    </div>
  );
}

/** Desconectar con confirmación en dos pasos (sin diálogo modal). */
export function DisconnectCard({
  what,
  onDisconnect,
}: {
  what: string;
  onDisconnect: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const err = await onDisconnect();
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setConfirming(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Desconectar</CardTitle>
        <CardDescription>
          Se borran las credenciales de {what}: dejarás de recibir y enviar
          mensajes por este canal. Las conversaciones ya guardadas se quedan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p className="text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-danger-text">¿Seguro?</span>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? "Desconectando…" : "Sí, desconectar"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Desconectar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function ChannelWebhookCard({
  webhook,
  description,
  secretEnv,
}: {
  webhook: ChannelWebhookInfo;
  description: React.ReactNode;
  secretEnv: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, which: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook para Meta</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!webhook.isHttps && (
          <p className="flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-3 text-xs text-warning-text">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            La URL configurada no es https: Meta exige https para los webhooks.
            Ajusta APP_BASE_URL con tu dominio público.
          </p>
        )}
        <div className="space-y-1.5">
          <Label>URL del webhook (callback URL)</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background/60 px-3 py-2 text-xs">
              {webhook.url}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copiar URL"
              onClick={() => copy(webhook.url, "url")}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {copied === "url" && (
              <span className="text-xs text-primary">Copiada ✓</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            La URL contiene el token secreto en la ruta: trátala como una
            contraseña.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Verify token</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background/60 px-3 py-2 text-xs">
              {webhook.verifyToken}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copiar verify token"
              onClick={() => copy(webhook.verifyToken, "vt")}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {copied === "vt" && (
              <span className="text-xs text-primary">Copiado ✓</span>
            )}
          </div>
        </div>
        {webhook.signatureLayer ? (
          <p className="flex items-center gap-2 text-xs text-success">
            <ShieldCheck className="h-4 w-4" /> Verificación de firma activa:
            cada evento se valida con x-hub-signature-256.
          </p>
        ) : (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" /> Sin App Secret
            configurado: el webhook queda protegido solo por la URL secreta.
            Para la capa extra de firma, agrega {secretEnv} a la instancia.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Aviso de la ventana de 24 h, común a Instagram y Messenger. */
export function HumanAgentNote() {
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      Meta solo deja responder dentro de las 24 h desde el último mensaje del
      cliente. Para contestar después (hasta 7 días) tu app necesita la función
      &quot;Human Agent&quot; aprobada en App Review.
    </p>
  );
}
