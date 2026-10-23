import { isOwner, type Role } from "@/lib/roles";

/**
 * Pestañas de Ajustes por rol (dev-tasks/00, RF-00-06). Lógica pura, sin
 * React: la usa `SettingsNav` y la cubre un unit test.
 */
export type SettingsTab = { href: string; label: string };

const WHATSAPP_TAB: SettingsTab = { href: "/settings/whatsapp", label: "WhatsApp" };

/**
 * 09 — Catálogo del negocio, lo usan todos. 029: también lo ve el Vendedor
 * (crea y edita las suyas si el Propietario lo permite).
 */
const QUICK_REPLIES_TAB: SettingsTab = {
  href: "/settings/quick-replies",
  label: "Respuestas rápidas",
};

const BUSINESS_TABS: SettingsTab[] = [
  { href: "/settings/branding", label: "Marca" },
  { href: "/settings/templates", label: "Plantillas" },
  QUICK_REPLIES_TAB,
  // 022 — Archivo de conversaciones inactivas (auto y limpieza masiva).
  { href: "/settings/inbox", label: "Bandeja" },
  { href: "/settings/team", label: "Equipo" },
];

/** 017 — Los canales extra solo aparecen si están en CHANNELS. */
const INSTAGRAM_TAB: SettingsTab = { href: "/settings/instagram", label: "Instagram" };
const MESSENGER_TAB: SettingsTab = { href: "/settings/messenger", label: "Messenger" };

/** 015 — "Agenda" solo existe si esta instancia encendió la bandera. */
const AGENDA_TAB: SettingsTab = { href: "/settings/calendar", label: "Agenda" };

/** 016 — Igual con "Anuncios" y la bandera ATRIBUCION. */
const ADS_TAB: SettingsTab = { href: "/settings/ads", label: "Anuncios" };

/** 011 — "Leads externos" solo con la bandera LEADS_EXTERNOS. */
const LEADS_EXTERNOS_TAB: SettingsTab = {
  href: "/settings/leads-externos",
  label: "Leads externos",
};

/** 019 — "Almacenamiento" solo con el conector del catálogo encendido (ADR-003). */
const STORAGE_TAB: SettingsTab = { href: "/settings/storage", label: "Almacenamiento" };

/** Pestaña común a ambos roles (029: junto con Respuestas rápidas). */
export const ACCOUNT_TAB: SettingsTab = { href: "/settings/account", label: "Mi cuenta" };

export function settingsTabsFor({
  role,
  agenda = false,
  atribucion = false,
  instagram = false,
  messenger = false,
  almacenamiento = false,
  leadsExternos = false,
}: {
  role: Role;
  agenda?: boolean;
  atribucion?: boolean;
  instagram?: boolean;
  messenger?: boolean;
  almacenamiento?: boolean;
  leadsExternos?: boolean;
}): SettingsTab[] {
  // El Vendedor no ve los ajustes del negocio: solo las respuestas rápidas
  // (029) y su cuenta.
  if (!isOwner(role)) return [QUICK_REPLIES_TAB, ACCOUNT_TAB];
  // Los canales van justo después de WhatsApp: son la misma clase de ajuste.
  return [
    WHATSAPP_TAB,
    ...(instagram ? [INSTAGRAM_TAB] : []),
    ...(messenger ? [MESSENGER_TAB] : []),
    ...BUSINESS_TABS,
    ...(agenda ? [AGENDA_TAB] : []),
    ...(atribucion ? [ADS_TAB] : []),
    ...(leadsExternos ? [LEADS_EXTERNOS_TAB] : []),
    ...(almacenamiento ? [STORAGE_TAB] : []),
    ACCOUNT_TAB,
  ];
}
