"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useViewer } from "@/components/viewer-context";
import { AlertsCard } from "@/components/alerts-menu";
import { passwordChangeError, validatePasswordChange } from "./account-errors";

type ClientError = { code?: string; status?: number };

/**
 * "Mi cuenta" (dev-tasks/00, RF-00-16): nombre y contraseña propia, para
 * cualquier rol. El tema se sigue cambiando desde el lateral.
 */
export function AccountClient({
  initialName,
  email,
}: {
  initialName: string;
  email: string;
}) {
  const { role } = useViewer();
  return (
    <div className="max-w-2xl space-y-6">
      <NameCard initialName={initialName} email={email} roleText={roleLabel(role)} />
      <PasswordCard />
      {/* 05: alertas del navegador, por usuario y dispositivo. */}
      <AlertsCard />
    </div>
  );
}

function NameCard({
  initialName,
  email,
  roleText,
}: {
  initialName: string;
  email: string;
  roleText: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const trimmed = name.trim();

  async function save() {
    setSaving(true);
    setError(null);
    setOk(false);
    const err: ClientError | null = await authClient
      .updateUser({ name: trimmed })
      .then((r) => r.error)
      .catch(() => ({ status: 0 }));
    setSaving(false);
    if (err) {
      setError(
        err.status === 0
          ? "Sin conexión con el servidor. Inténtalo de nuevo."
          : "No se pudo guardar el nombre. Inténtalo de nuevo."
      );
      return;
    }
    setSaved(trimmed);
    setName(trimmed);
    setOk(true);
    // El nombre del lateral se lee en el servidor: refrescar lo actualiza.
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tu perfil</CardTitle>
        <CardDescription>
          {email ? `${email} · ${roleText}` : roleText}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving && trimmed && trimmed !== saved) void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="account-name">Nombre</Label>
            <Input
              id="account-name"
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setOk(false);
              }}
            />
          </div>
          {error && (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}
          {ok && <p className="text-sm text-success-text">Nombre guardado ✓</p>}
          <Button type="submit" disabled={saving || !trimmed || trimmed === saved}>
            {saving ? "Guardando…" : "Guardar nombre"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save() {
    setOk(false);
    const invalid = validatePasswordChange({ current, next, confirm });
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    const err: ClientError | null = await authClient
      .changePassword({
        currentPassword: current,
        newPassword: next,
        // Cierra las demás sesiones (otros dispositivos); la actual sigue.
        revokeOtherSessions: true,
      })
      .then((r) => r.error)
      .catch(() => ({ status: 0 }));
    setSaving(false);
    if (err) {
      setError(
        err.status === 0
          ? "Sin conexión con el servidor. Inténtalo de nuevo."
          : passwordChangeError(err)
      );
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    setOk(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cambiar contraseña</CardTitle>
        <CardDescription>
          Al cambiarla se cierran tus sesiones en otros dispositivos; esta sigue
          abierta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="account-current">Contraseña actual</Label>
            <Input
              id="account-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="account-new">Nueva contraseña</Label>
              <Input
                id="account-new"
                type="password"
                autoComplete="new-password"
                placeholder="mínimo 8 caracteres"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-confirm">Repite la nueva</Label>
              <Input
                id="account-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <p className="text-sm text-danger-text" role="alert">
              {error}
            </p>
          )}
          {ok && (
            <p className="text-sm text-success-text">
              Contraseña actualizada ✓ Tus otras sesiones se cerraron.
            </p>
          )}
          <Button type="submit" disabled={saving || !current || !next || !confirm}>
            {saving ? "Guardando…" : "Cambiar contraseña"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
