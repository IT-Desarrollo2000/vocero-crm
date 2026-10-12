"use client";

import { useCallback, useEffect, useState } from "react";
import { notificationSupport, type NotificationSupport } from "@/lib/alerts";
import { playAlertSound, unlockAudio } from "@/components/alert-sound";
import { brandIconHref } from "@/components/favicon-badge";
import { useAlertPrefs } from "@/components/use-alert-prefs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Panel de alertas (dev-tasks/05, RF-05-01, RF-05-10, RF-05-14): activar
 * notificaciones del navegador (el permiso se pide SOLO tras el clic), qué
 * avisa, sonido, vista previa, contador en la pestaña y «Probar». Cada
 * preferencia es por usuario y por dispositivo.
 *
 * `AlertsMenu` es el contenido (para un popover del lateral) y `AlertsCard`
 * lo envuelve como tarjeta de «Mi cuenta».
 */

function readSupport(): NotificationSupport {
  if (typeof window === "undefined") return "unsupported";
  const has = typeof Notification !== "undefined";
  return notificationSupport({
    hasNotification: has,
    isSecureContext: window.isSecureContext,
    permission: has ? Notification.permission : null,
  });
}

const SUPPORT_TEXT: Record<Exclude<NotificationSupport, "granted" | "default">, string> = {
  unsupported:
    "Este navegador no permite notificaciones del sistema (por ejemplo, Safari en iPhone fuera de la app instalada). El contador en la pestaña y el sonido siguen funcionando.",
  insecure:
    "Las notificaciones solo funcionan con HTTPS. Abre el CRM con https:// para activarlas; el contador en la pestaña y el sonido siguen funcionando.",
  denied:
    "Bloqueaste las notificaciones en este navegador. Para volver a permitirlas, toca el candado junto a la dirección, busca «Notificaciones» y elige «Permitir»; luego recarga la página.",
};

export function AlertsMenu() {
  const [prefs, update] = useAlertPrefs();
  const [support, setSupport] = useState<NotificationSupport>("unsupported");
  const [ready, setReady] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // El permiso puede cambiar fuera de la app (revocado en los ajustes del
  // sitio): se relee al montar y al volver a la pestaña.
  useEffect(() => {
    const refresh = () => setSupport(readSupport());
    refresh();
    setReady(true);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const activate = useCallback(async () => {
    // Mismo gesto: desbloquear el audio para que el sonido pueda sonar.
    unlockAudio();
    setNotice(null);
    setAsking(true);
    let result: NotificationPermission = "default";
    try {
      result = await Notification.requestPermission();
    } catch {
      result = "default";
    }
    setAsking(false);
    setSupport(readSupport());
    if (result === "granted") {
      update({ notifications: true });
    } else if (result === "default") {
      setNotice("No elegiste una opción en el aviso del navegador. Vuelve a intentarlo.");
    }
  }, [update]);

  const test = useCallback(() => {
    unlockAudio();
    setNotice(null);
    let shown = false;
    if (support === "granted") {
      try {
        new Notification("Prueba de alertas", {
          body: "Así te avisaremos cuando te escriban o te necesiten.",
          tag: "vocero:test",
          icon: brandIconHref(document),
        });
        shown = true;
      } catch {
        shown = false;
      }
    }
    // El AudioContext recién creado puede tardar un instante en arrancar.
    setTimeout(() => playAlertSound({ force: true }), 60);
    if (!shown) {
      setNotice(
        support === "granted"
          ? "Este navegador no deja mostrar notificaciones desde la página (en Android hace falta instalar la app)."
          : prefs.sound
            ? "Sonido de prueba reproducido. Activa las notificaciones para ver el aviso."
            : "Activa las notificaciones o el sonido para probar."
      );
    }
  }, [support, prefs.sound]);

  if (!ready) return null;

  const granted = support === "granted";
  const notificationsOn = granted && prefs.notifications;

  return (
    <div className="space-y-4">
      {support === "default" && (
        <div className="space-y-2">
          <p className="text-sm text-text-2">
            Recibe un aviso cuando te escriba un cliente o una conversación
            necesite atención humana, aunque estés en otra pestaña.
          </p>
          <Button onClick={() => void activate()} disabled={asking}>
            {asking ? "Esperando tu respuesta…" : "Activar notificaciones"}
          </Button>
        </div>
      )}
      {support !== "default" && support !== "granted" && (
        <p className="text-sm text-warning-text" role="status">
          {SUPPORT_TEXT[support]}
        </p>
      )}

      {granted && (
        <Toggle
          label="Notificaciones"
          hint="Avisos del sistema en este navegador."
          checked={prefs.notifications}
          onChange={(v) => update({ notifications: v })}
        />
      )}
      {notificationsOn && (
        <div className="space-y-3 border-l pl-4">
          <Toggle
            label="Mensajes nuevos"
            checked={prefs.incoming}
            onChange={(v) => update({ incoming: v })}
          />
          <Toggle
            label="Necesita atención humana"
            hint="Cuando el agente escala una conversación."
            checked={prefs.handoffs}
            onChange={(v) => update({ handoffs: v })}
          />
          <Toggle
            label="Mostrar el contenido"
            hint="Apágalo si otras personas ven tu pantalla."
            checked={prefs.showContent}
            onChange={(v) => update({ showContent: v })}
          />
        </div>
      )}
      <Toggle
        label="Sonido"
        hint="Un tono corto, como máximo uno cada 3 segundos."
        checked={prefs.sound}
        onChange={(v) => {
          if (v) unlockAudio();
          update({ sound: v });
        }}
      />
      <Toggle
        label="Contador en la pestaña"
        hint="Muestra «(3)» en el título y un punto en el icono."
        checked={prefs.tabCounter}
        onChange={(v) => update({ tabCounter: v })}
      />

      {notice && (
        <p className="text-sm text-text-2" role="status">
          {notice}
        </p>
      )}
      <Button variant="outline" size="sm" onClick={test}>
        Probar
      </Button>
    </div>
  );
}

export function AlertsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alertas en este navegador</CardTitle>
        <CardDescription>
          Se guardan solo en este dispositivo. Las notificaciones las muestra tu
          navegador; nada sale a otros servicios.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertsMenu />
      </CardContent>
    </Card>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-text-2">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? "bg-brand" : "bg-border-strong"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-knob shadow-sm transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
