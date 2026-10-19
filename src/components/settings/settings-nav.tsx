"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { settingsTabsFor } from "./settings-tabs";

export function SettingsNav({
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
}) {
  const pathname = usePathname();
  // Qué pestañas existen lo decide el servidor y baja por prop: este es un
  // componente de cliente y no puede leer variables de entorno.
  const tabs = settingsTabsFor({
    role,
    agenda,
    atribucion,
    instagram,
    messenger,
    almacenamiento,
    leadsExternos,
  });
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-44 sm:flex-col sm:space-y-1 sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cn(
            "block shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
            pathname.startsWith(t.href)
              ? "bg-brand-tint text-brand-text"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
