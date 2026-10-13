import { isOwner, type Role } from "@/lib/roles";

/**
 * Pestañas de Ajustes por rol (dev-tasks/00, RF-00-06). Lógica pura, sin
 * React: la usa `SettingsNav` y la cubre un unit test.
 */
export type SettingsTab = { href: string; label: string };

const WHATSAPP_TAB: SettingsTab = { href: "/settings/whatsapp", label: "WhatsApp" };

const BUSINESS_TABS: SettingsTab[] = [
  { href: "/settings/branding", label: "Marca" },
  { href: "/settings/templates", label: "Plantillas" },
  // 09 — Catálogo del negocio: lo gestiona el Propietario, lo usan todos.
  { href: "/settings/quick-replies", label: "Respuestas rápidas" },
  { href: "/settings/team", label: "Equipo" },
];

/** 017 — Los canales extra solo aparecen si están en CHANNELS. */
const INSTAGRAM_TAB: SettingsTab = { href: "/settings/instagram", label: "Instagram" };
const MESSENGER_TAB: SettingsTab = { href: "/settings/messenger", label: "Messenger" };

/** 015 — "Agenda" solo existe si esta instancia encendió la bandera. */
const AGENDA_TAB: SettingsTab = { href: "/settings/calendar", label: "Agenda" };

/** 016 — Igual con "Anuncios" y la bandera ATRIBUCION. */
const ADS_TAB: SettingsTab = { href: "/settings/ads", label: "Anuncios" };

/** La única pestaña común a ambos roles. */
export const ACCOUNT_TAB: SettingsTab = { href: "/settings/account", label: "Mi cuenta" };

export function settingsTabsFor({
  role,
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
}: {
  role: Role;
  agenda?: boolean;
  atribucion?: boolean;
  instagram?: boolean;
  messenger?: boolean;
}): SettingsTab[] {
  // El Vendedor no ve ningún ajuste del negocio: solo su cuenta.
  if (!isOwner(role)) return [ACCOUNT_TAB];
  // Los canales van justo después de WhatsApp: son la misma clase de ajuste.
  return [
    WHATSAPP_TAB,
    ...(instagram ? [INSTAGRAM_TAB] : []),
    ...(messenger ? [MESSENGER_TAB] : []),
    ...BUSINESS_TABS,
    ...(agenda ? [AGENDA_TAB] : []),
    ...(atribucion ? [ADS_TAB] : []),
    ACCOUNT_TAB,
  ];
}
