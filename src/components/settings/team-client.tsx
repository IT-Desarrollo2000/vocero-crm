"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, UserMinus, UserPlus } from "lucide-react";
import { ContactAvatar } from "@/components/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useViewer } from "@/components/viewer-context";
import { ROLE_LABELS, roleLabel, type Role } from "@/lib/roles";

/** Contrato de `GET /api/settings/team` (dev-tasks/00, T-00-17). */
type Member = {
  /** id de la membresía: es el que llevan las rutas `[memberId]`. */
  id: string;
  userId: string;
  role: Role;
  name: string;
  email: string;
  createdAt: string;
};

type ApiError = { error?: { code?: string; message?: string } } | null;

/** Mensaje del servidor si lo hay; si no, uno genérico por código. */
async function errorMessage(res: Response | null, fallback: string) {
  if (!res) return "Sin conexión con el servidor";
  const data = (await res.json().catch(() => null)) as ApiError;
  if (data?.error?.message) return data.error.message;
  switch (data?.error?.code) {
    case "self_change":
      return "No puedes cambiar tu propio rol ni darte de baja: usa Mi cuenta.";
    case "last_owner":
      return "Debe quedar al menos un Propietario.";
    case "not_found":
      return "Ese miembro ya no existe. Recarga la página.";
    default:
      return fallback;
  }
}

const ROLES = Object.keys(ROLE_LABELS) as Role[];

export function TeamClient() {
  const { userId: viewerId } = useViewer();
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tempPassword, setTempPassword] = useState("");
  const [created, setCreated] = useState<{
    email: string;
    password: string;
    relinked: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Acciones por fila: una sola a la vez, con su error en la propia fila.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // La temporal se muestra UNA vez: vive aquí hasta que se cierra, y un
  // refetch no la borra.
  const [reset, setReset] = useState<{
    name: string;
    email: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/settings/team").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { members: Member[] };
    setMembers(data.members);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  function generatePassword() {
    const alphabet =
      "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(14);
    crypto.getRandomValues(bytes);
    setTempPassword(
      Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
    );
  }

  async function create() {
    setSaving(true);
    setError(null);
    setCreated(null);
    const res = await fetch("/api/settings/team", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password: tempPassword }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await errorMessage(res, "No se pudo crear la cuenta"));
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      relinked?: boolean;
    } | null;
    setCreated({ email, password: tempPassword, relinked: data?.relinked === true });
    setName("");
    setEmail("");
    setTempPassword("");
    void refetch();
  }

  async function changeRole(m: Member, role: Role) {
    if (role === m.role) return;
    setBusyId(m.id);
    setRowError(null);
    const res = await fetch(`/api/settings/team/${encodeURIComponent(m.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }).catch(() => null);
    setBusyId(null);
    if (!res?.ok) {
      setRowError({ id: m.id, message: await errorMessage(res, "No se pudo cambiar el rol") });
      return;
    }
    void refetch();
  }

  async function remove(m: Member) {
    setBusyId(m.id);
    setRowError(null);
    const res = await fetch(`/api/settings/team/${encodeURIComponent(m.id)}`, {
      method: "DELETE",
    }).catch(() => null);
    setBusyId(null);
    if (!res?.ok) {
      setRowError({ id: m.id, message: await errorMessage(res, "No se pudo dar de baja") });
      return;
    }
    setConfirmingId(null);
    void refetch();
  }

  async function resetPassword(m: Member) {
    setBusyId(m.id);
    setRowError(null);
    setReset(null);
    setCopied(false);
    const res = await fetch(
      `/api/settings/team/${encodeURIComponent(m.id)}/reset-password`,
      { method: "POST" }
    ).catch(() => null);
    setBusyId(null);
    if (!res?.ok) {
      setRowError({
        id: m.id,
        message: await errorMessage(res, "No se pudo restablecer la contraseña"),
      });
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      temporaryPassword?: string;
    } | null;
    if (!data?.temporaryPassword) {
      setRowError({ id: m.id, message: "El servidor no devolvió la contraseña temporal" });
      return;
    }
    setReset({ name: m.name, email: m.email, password: data.temporaryPassword });
  }

  function copyReset() {
    if (!reset) return;
    void navigator.clipboard.writeText(reset.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Crear cuenta de equipo</CardTitle>
          <CardDescription>
            Sin correos ni invitaciones: comparte tú mismo la contraseña
            temporal con tu compañero (se muestra UNA sola vez). Las cuentas
            nuevas entran como Vendedor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Nombre</Label>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-email">Correo</Label>
              <Input
                id="team-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-password">Contraseña temporal</Label>
            <div className="flex gap-2">
              <Input
                id="team-password"
                value={tempPassword}
                onChange={(e) => setTempPassword(e.target.value)}
                placeholder="mínimo 8 caracteres"
              />
              <Button variant="outline" onClick={generatePassword}>
                Generar
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {created && (
            <div className="rounded-md border border-success-soft bg-success-tint p-3 text-sm">
              <p className="font-medium text-success-text">
                {created.relinked ? "Cuenta reactivada ✓" : "Cuenta creada ✓"}
              </p>
              <p className="mt-1 text-success-text opacity-90">
                Comparte estos datos ahora (no se volverán a mostrar):
                <br />
                <code>{created.email}</code> · contraseña{" "}
                <code>{created.password}</code>
              </p>
            </div>
          )}
          <Button
            disabled={
              saving || !name.trim() || !email.trim() || tempPassword.length < 8
            }
            onClick={() => void create()}
          >
            <UserPlus className="h-4 w-4" />
            {saving ? "Creando…" : "Crear cuenta"}
          </Button>
        </CardContent>
      </Card>

      {reset && (
        <div
          className="rounded-md border border-success-soft bg-success-tint p-3 text-sm"
          role="status"
        >
          <p className="font-medium text-success-text">
            Contraseña restablecida ✓
          </p>
          <p className="mt-1 text-success-text opacity-90">
            Compártela ahora con {reset.name}: no se volverá a mostrar. Sus
            sesiones abiertas se cerraron.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-md border bg-card px-3 py-1.5 text-xs">
              {reset.email}
            </code>
            <code className="rounded-md border bg-card px-3 py-1.5 text-xs">
              {reset.password}
            </code>
            <Button
              variant="outline"
              size="sm"
              aria-label="Copiar contraseña temporal"
              onClick={copyReset}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copiada ✓" : "Copiar"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setReset(null)}>
              Entendido
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Miembros
        </p>
        {members.map((m) => {
          const self = m.userId === viewerId;
          const busy = busyId === m.id;
          const confirming = confirmingId === m.id;
          return (
            <div key={m.id} className="rounded-lg border bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <ContactAvatar name={m.name} seed={m.id} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.name}
                    {self && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        (tú)
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                {self ? (
                  // La fila propia no tiene acciones: tu rol lo cambia otro
                  // Propietario y tu contraseña, "Mi cuenta".
                  <Badge variant={m.role === "owner" ? "default" : "secondary"}>
                    {roleLabel(m.role)}
                  </Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Rol de ${m.name}`}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => void changeRole(m, e.target.value as Role)}
                      className="h-8 rounded-md border border-input bg-card px-2 text-xs"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void resetPassword(m)}
                    >
                      <KeyRound className="h-4 w-4" />
                      Restablecer contraseña
                    </Button>
                    {!confirming && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRowError(null);
                          setConfirmingId(m.id);
                        }}
                      >
                        <UserMinus className="h-4 w-4" />
                        Dar de baja
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {confirming && !self && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-danger-text">
                    ¿Dar de baja a {m.name}? Se cierran todas sus sesiones y ya
                    no podrá entrar.
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(m)}
                  >
                    {busy ? "Dando de baja…" : "Sí, dar de baja"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingId(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              )}
              {rowError?.id === m.id && (
                <p className="mt-2 text-sm text-danger-text" role="alert">
                  {rowError.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
